import argparse
import json
import re
from collections import Counter
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


def route_session(session, compiled, default_route):
    categories = set()
    hit_count = 0

    for message in session.get("messages", []):
        text = str(message.get("text", ""))
        hits = scan_text(text, compiled)
        hit_count += len(hits)
        for hit in hits:
            categories.add(f"{hit['route']}:{hit['category']}")

    route = "api_blocked" if any(category.startswith("api_blocked:") for category in categories) else default_route
    return route, sorted(categories), hit_count


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


def write_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def filter_sessions(input_path, allowed_output, blocked_output, policy_path, summary_path):
    policy = load_policy(policy_path)
    compiled = compile_policy(policy)
    default_route = policy.get("default_route", "api_allowed")

    allowed_output.parent.mkdir(parents=True, exist_ok=True)
    blocked_output.parent.mkdir(parents=True, exist_ok=True)
    if summary_path:
        summary_path.parent.mkdir(parents=True, exist_ok=True)

    route_counts = Counter()
    route_message_counts = Counter()
    category_counts = Counter()
    total_sessions = 0
    total_messages = 0

    with allowed_output.open("w", encoding="utf-8", newline="\n") as allowed_f, blocked_output.open(
        "w", encoding="utf-8", newline="\n"
    ) as blocked_f:
        for _, session in iter_jsonl(input_path):
            total_sessions += 1
            message_count = int(session.get("message_count") or len(session.get("messages", [])))
            total_messages += message_count

            route, categories, hit_count = route_session(session, compiled, default_route)
            route_counts[route] += 1
            route_message_counts[route] += message_count
            for category in categories:
                category_counts[category] += 1

            session["api_review"] = {
                "route": route,
                "matched_categories": categories,
                "matched_rule_count": hit_count,
            }

            if route == "api_blocked":
                write_row(blocked_f, session)
            else:
                write_row(allowed_f, session)

    summary = {
        "input": str(input_path),
        "policy": str(policy_path),
        "allowed_output": str(allowed_output),
        "blocked_output": str(blocked_output),
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "route_sessions": dict(route_counts),
        "route_messages": dict(route_message_counts),
        "matched_category_sessions": dict(category_counts),
    }

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary_path:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Route whole chat sessions with the API review policy.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--policy", type=Path, default=Path("config/api_review_policy.json"))
    parser.add_argument("--allowed-output", required=True, type=Path)
    parser.add_argument("--blocked-output", required=True, type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    filter_sessions(
        input_path=args.input,
        allowed_output=args.allowed_output,
        blocked_output=args.blocked_output,
        policy_path=args.policy,
        summary_path=args.summary,
    )


if __name__ == "__main__":
    main()
