import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


def load_policy(path):
    return json.loads(path.read_text(encoding="utf-8"))


def compile_policy(policy):
    compiled = []
    for route, route_data in policy.get("routes", {}).items():
        for category, category_data in route_data.get("categories", {}).items():
            for term in category_data.get("terms", []):
                if term:
                    compiled.append({
                        "route": route,
                        "kind": "term",
                        "category": category,
                        "name": term,
                        "matcher": term,
                    })
        for item in route_data.get("regex", []):
            compiled.append({
                "route": route,
                "kind": "regex",
                "category": "regex",
                "name": item["name"],
                "matcher": re.compile(item["pattern"]),
            })
    return compiled


def scan_text(text, compiled):
    hits = []
    for rule in compiled:
        if rule["kind"] == "term":
            if rule["matcher"] in text:
                hits.append(rule)
        elif rule["matcher"].search(text):
            hits.append(rule)
    return hits


def strongest_route(hits, default_route):
    if any(hit["route"] == "api_blocked" for hit in hits):
        return "api_blocked"
    return default_route


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            yield line_no, json.loads(line)


def scan_chat_file(path, compiled, default_route):
    route_counts = Counter()
    category_counts = Counter()
    term_counts = Counter()
    total = 0

    for _, obj in iter_jsonl(path):
        total += 1
        text = str(obj.get("text", ""))
        hits = scan_text(text, compiled)
        route = strongest_route(hits, default_route)
        route_counts[route] += 1
        seen_categories = set()
        seen_terms = set()
        for hit in hits:
            seen_categories.add(f"{hit['route']}:{hit['category']}")
            seen_terms.add(f"{hit['route']}:{hit['name']}")
        for category in seen_categories:
            category_counts[category] += 1
        for term in seen_terms:
            term_counts[term] += 1

    return {
        "total": total,
        "routes": dict(route_counts),
        "categories": dict(category_counts.most_common()),
        "top_terms": dict(term_counts.most_common(80)),
    }


def collect_boundary_text(sample):
    parts = []
    for item in sample.get("left_messages", []):
        parts.append(str(item.get("text", "")))
    for item in sample.get("right_messages", []):
        parts.append(str(item.get("text", "")))
    return "\n".join(parts)


def scan_boundary_samples(path, compiled, default_route):
    route_counts = Counter()
    bucket_route_counts = defaultdict(Counter)
    category_counts = Counter()
    total = 0

    for _, obj in iter_jsonl(path):
        total += 1
        text = collect_boundary_text(obj)
        hits = scan_text(text, compiled)
        route = strongest_route(hits, default_route)
        route_counts[route] += 1
        bucket_route_counts[obj.get("bucket", "")][route] += 1
        for category in {f"{hit['route']}:{hit['category']}" for hit in hits}:
            category_counts[category] += 1

    return {
        "total": total,
        "routes": dict(route_counts),
        "bucket_routes": {bucket: dict(counts) for bucket, counts in sorted(bucket_route_counts.items())},
        "categories": dict(category_counts.most_common()),
    }


def main():
    parser = argparse.ArgumentParser(description="Scan chat data or boundary samples with API review policy.")
    parser.add_argument("--policy", type=Path, default=Path("config/api_review_policy.json"))
    parser.add_argument("--chat", type=Path, action="append", default=[])
    parser.add_argument("--boundary-samples", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    policy = load_policy(args.policy)
    compiled = compile_policy(policy)
    default_route = policy.get("default_route", "allow_api")

    summary = {
        "policy": str(args.policy),
        "default_route": default_route,
        "chat_files": {},
        "boundary_samples": None,
    }

    for path in args.chat:
        summary["chat_files"][str(path)] = scan_chat_file(path, compiled, default_route)

    if args.boundary_samples:
        summary["boundary_samples"] = scan_boundary_samples(args.boundary_samples, compiled, default_route)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
