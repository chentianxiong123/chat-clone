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
                        "matcher": term,
                    })
        for item in route_data.get("regex", []):
            compiled.append({
                "route": route,
                "kind": "regex",
                "category": "regex",
                "matcher": re.compile(item["pattern"]),
            })
    return compiled


def scan_text(text, compiled):
    hits = []
    if not text:
        return hits
    for rule in compiled:
        if rule["kind"] == "term":
            if rule["matcher"] in text:
                hits.append(rule)
        elif rule["matcher"].search(text):
            hits.append(rule)
    return hits


def collect_text(sample):
    parts = []
    for side in ("left_messages", "right_messages"):
        for message in sample.get(side, []):
            parts.append(str(message.get("text", "")))
    return "\n".join(parts)


def route_sample(sample, compiled, default_route):
    hits = scan_text(collect_text(sample), compiled)
    categories = sorted({f"{hit['route']}:{hit['category']}" for hit in hits})
    route = "api_blocked" if any(hit["route"] == "api_blocked" for hit in hits) else default_route
    return route, categories, len(hits)


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield line_no, json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc


def write_jsonl_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def route_boundary_samples(input_path, policy_path, allowed_output, manual_review_output, summary_path):
    policy = load_policy(policy_path)
    compiled = compile_policy(policy)
    default_route = policy.get("default_route", "api_allowed")

    allowed_output.parent.mkdir(parents=True, exist_ok=True)
    manual_review_output.parent.mkdir(parents=True, exist_ok=True)
    if summary_path:
        summary_path.parent.mkdir(parents=True, exist_ok=True)

    route_counts = Counter()
    bucket_route_counts = defaultdict(Counter)
    category_counts = Counter()
    total = 0

    with allowed_output.open("w", encoding="utf-8", newline="\n") as allowed_f, manual_review_output.open(
        "w", encoding="utf-8", newline="\n"
    ) as manual_f:
        for _, sample in iter_jsonl(input_path):
            total += 1
            route, categories, hit_count = route_sample(sample, compiled, default_route)
            review_status = "manual_review_required" if route == "api_blocked" else "external_api_ok"
            sample["api_review"] = {
                "route": route,
                "review_status": review_status,
                "matched_categories": categories,
                "matched_rule_count": hit_count,
            }

            bucket = str(sample.get("bucket", ""))
            route_counts[route] += 1
            bucket_route_counts[bucket][route] += 1
            for category in categories:
                category_counts[category] += 1

            if route == "api_blocked":
                write_jsonl_row(manual_f, sample)
            else:
                write_jsonl_row(allowed_f, sample)

    summary = {
        "input": str(input_path),
        "policy": str(policy_path),
        "allowed_output": str(allowed_output),
        "manual_review_output": str(manual_review_output),
        "total": total,
        "routes": dict(route_counts),
        "bucket_routes": {bucket: dict(counts) for bucket, counts in sorted(bucket_route_counts.items())},
        "matched_category_samples": dict(category_counts),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary_path:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Route boundary samples for external API or manual review.")
    parser.add_argument("--input", type=Path, default=Path("data/boundary_samples.jsonl"))
    parser.add_argument("--policy", type=Path, default=Path("config/api_review_policy.json"))
    parser.add_argument("--allowed-output", type=Path, default=Path("data/boundary_samples_api_allowed.jsonl"))
    parser.add_argument(
        "--manual-review-output",
        type=Path,
        default=Path("data/boundary_samples_manual_review.jsonl"),
    )
    parser.add_argument("--summary", type=Path, default=Path("data/boundary_samples_api_route.summary.json"))
    args = parser.parse_args()

    route_boundary_samples(
        input_path=args.input,
        policy_path=args.policy,
        allowed_output=args.allowed_output,
        manual_review_output=args.manual_review_output,
        summary_path=args.summary,
    )


if __name__ == "__main__":
    main()
