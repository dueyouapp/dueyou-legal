#!/usr/bin/env python3
"""One-shot, exact-tip branch hygiene for the public DueYou launcher repo.

Only the explicit historical target list is eligible. Open-PR heads and GitHub-
protected branches are always preserved. Branch tips already reachable from
main may be deleted directly because their exact commits remain reachable from
main. Diverged/unreachable tips must first receive a remotely verified archive
tag that reversibly encodes the branch name and exact tip SHA.

The workflow invoking apply mode is deliberately gated by a unique merge-commit
marker so this does not become an aggressive always-on public branch cleaner.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import urllib.parse
import urllib.request
from typing import Any

ARCHIVE_PREFIX = "archive/branch-tip"
TARGET_BRANCHES = (
    "agent/compliance-and-site-hardening",
    "agent/control-room-cache-bust-v1",
    "agent/control-room-loader-contract-v1",
    "agent/fix-mobile-github-fetch",
    "agent/fix-v43-launcher-script-termination",
    "agent/kucoin-browser-transport-v1",
    "agent/require-control-room-v4",
    "agent/v4-live-compat-bridge",
    "agent/v4-script-isolation",
    "dashboard-v5-launcher",
    "fix/control-room-runtime-contract",
    "fix/kucoin-runtime-release-launcher",
    "audit/public-branch-hygiene-2026-08-21",
)


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run("git", *args, check=check)


def archive_tag(branch: str, sha: str) -> str:
    encoded = base64.urlsafe_b64encode(branch.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{ARCHIVE_PREFIX}/{encoded}/{sha}"


def decode_archive_branch(tag: str) -> str:
    prefix = ARCHIVE_PREFIX + "/"
    if not tag.startswith(prefix):
        raise ValueError("not a public branch archive tag")
    remainder = tag[len(prefix) :]
    encoded, sep, sha = remainder.partition("/")
    if not sep or len(sha) != 40:
        raise ValueError("malformed public branch archive tag")
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    return base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode("utf-8")


def github_list(repository: str, resource: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GH_TOKEN or GITHUB_TOKEN is required")
    api_root = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    repo = urllib.parse.quote(repository, safe="/")
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        query = {"per_page": "100", "page": str(page)}
        if params:
            query.update(params)
        url = f"{api_root}/repos/{repo}/{resource}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "dueyou-public-branch-hygiene",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        if not isinstance(payload, list):
            raise RuntimeError(f"GitHub API {resource} returned non-list payload")
        rows.extend(row for row in payload if isinstance(row, dict))
        if len(payload) < 100:
            break
        page += 1
        if page > 20:
            raise RuntimeError(f"pagination runaway for {resource}")
    return rows


def metadata(repository: str) -> tuple[set[str], set[str]]:
    branches = github_list(repository, "branches")
    pulls = github_list(repository, "pulls", {"state": "open"})
    protected = {
        str(row["name"])
        for row in branches
        if row.get("name") and bool(row.get("protected"))
    }
    open_heads: set[str] = set()
    for row in pulls:
        head = row.get("head") or {}
        repo = head.get("repo") or {}
        ref = head.get("ref")
        if ref and (not repo.get("full_name") or repo.get("full_name") == repository):
            open_heads.add(str(ref))
    return protected, open_heads


def fetch_heads(remote: str = "origin") -> dict[str, str]:
    git("fetch", "--force", "--prune", remote, f"+refs/heads/*:refs/remotes/{remote}/*")
    proc = git(
        "for-each-ref",
        "--format=%(refname)\t%(objectname)",
        f"refs/remotes/{remote}/",
    )
    prefix = f"refs/remotes/{remote}/"
    result: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        ref, sha = line.split("\t", 1)
        if not ref.startswith(prefix):
            continue
        name = ref[len(prefix) :]
        if name != "HEAD":
            result[name] = sha
    return result


def is_ancestor(sha: str, main_sha: str) -> bool:
    proc = git("merge-base", "--is-ancestor", sha, main_sha, check=False)
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    raise RuntimeError(proc.stderr.strip() or "merge-base failed")


def remote_tag_sha(tag: str, remote: str = "origin") -> str | None:
    proc = git("ls-remote", "--tags", remote, f"refs/tags/{tag}", check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ls-remote failed for {tag}")
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        return None
    if len(lines) != 1:
        raise RuntimeError(f"unexpected remote tag multiplicity for {tag}")
    sha, ref = lines[0].split("\t", 1)
    if ref != f"refs/tags/{tag}":
        raise RuntimeError(f"unexpected tag ref {ref}")
    return sha


def ensure_archive(branch: str, sha: str, remote: str = "origin") -> str:
    tag = archive_tag(branch, sha)
    existing = remote_tag_sha(tag, remote)
    if existing is None:
        proc = git("push", "--atomic", remote, f"{sha}:refs/tags/{tag}", check=False)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"archive push failed for {branch}")
        existing = remote_tag_sha(tag, remote)
    if existing != sha:
        raise RuntimeError(
            f"archive tag {tag} expected {sha} but resolves to {existing}"
        )
    return tag


def classify_targets(
    heads: dict[str, str],
    *,
    main_sha: str,
    protected: set[str],
    open_heads: set[str],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for name in TARGET_BRANCHES:
        sha = heads.get(name)
        if sha is None:
            rows.append({"branch": name, "sha": "", "classification": "MISSING"})
        elif name in protected:
            rows.append({"branch": name, "sha": sha, "classification": "PRESERVE_PROTECTED"})
        elif name in open_heads:
            rows.append({"branch": name, "sha": sha, "classification": "PRESERVE_OPEN_PR"})
        elif is_ancestor(sha, main_sha):
            rows.append({"branch": name, "sha": sha, "classification": "SAFE_REACHABLE"})
        else:
            rows.append({"branch": name, "sha": sha, "classification": "ARCHIVE_REQUIRED"})
    return rows


def delete_exact(branch: str, sha: str, remote: str = "origin") -> None:
    proc = git(
        "push",
        f"--force-with-lease=refs/heads/{branch}:{sha}",
        remote,
        f":refs/heads/{branch}",
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"exact-tip delete failed for {branch}")


def self_test() -> int:
    branch = "agent/example/branch"
    sha = "a" * 40
    tag = archive_tag(branch, sha)
    assert decode_archive_branch(tag) == branch
    assert tag.endswith("/" + sha)
    assert len(TARGET_BRANCHES) == len(set(TARGET_BRANCHES))
    assert "main" not in TARGET_BRANCHES
    assert all(name.strip() == name and name for name in TARGET_BRANCHES)
    print("PUBLIC_BRANCH_HYGIENE_SELF_TEST_PASS")
    return 0


def apply(repository: str, expected_main_sha: str, remote: str = "origin") -> int:
    heads = fetch_heads(remote)
    observed_main = heads.get("main")
    if observed_main != expected_main_sha:
        raise RuntimeError(
            f"origin/main {observed_main} != triggering main {expected_main_sha}; refusing stale cleanup"
        )
    protected, open_heads = metadata(repository)
    rows = classify_targets(
        heads,
        main_sha=expected_main_sha,
        protected=protected,
        open_heads=open_heads,
    )

    archives: dict[tuple[str, str], str] = {}
    for row in rows:
        if row["classification"] == "ARCHIVE_REQUIRED":
            archives[(row["branch"], row["sha"])] = ensure_archive(
                row["branch"], row["sha"], remote
            )

    # Re-fetch everything after archival. A branch that moved, became protected,
    # or became an open PR head is preserved. Main advancement aborts the run.
    fresh_heads = fetch_heads(remote)
    if fresh_heads.get("main") != expected_main_sha:
        raise RuntimeError("main advanced during cleanup; refusing branch deletion")
    fresh_protected, fresh_open_heads = metadata(repository)
    fresh_rows = classify_targets(
        fresh_heads,
        main_sha=expected_main_sha,
        protected=fresh_protected,
        open_heads=fresh_open_heads,
    )

    deleted: list[str] = []
    preserved: list[dict[str, str]] = []
    for row in fresh_rows:
        branch = row["branch"]
        sha = row["sha"]
        classification = row["classification"]
        if classification in {"MISSING", "PRESERVE_PROTECTED", "PRESERVE_OPEN_PR"}:
            preserved.append(row)
            continue
        if classification == "ARCHIVE_REQUIRED":
            tag = archives.get((branch, sha))
            if not tag or remote_tag_sha(tag, remote) != sha:
                preserved.append({**row, "classification": "PRESERVE_ARCHIVE_UNPROVEN"})
                continue
        delete_exact(branch, sha, remote)
        deleted.append(branch)

    final_heads = fetch_heads(remote)
    still_present = [name for name in TARGET_BRANCHES if name in final_heads]
    result = {
        "expected_main_sha": expected_main_sha,
        "target_count": len(TARGET_BRANCHES),
        "archived_unique_count": len(archives),
        "deleted": deleted,
        "preserved": preserved,
        "still_present": still_present,
        "policy": {
            "allow_delete_main": False,
            "allow_delete_open_pr_head": False,
            "allow_delete_protected_branch": False,
            "allow_delete_unreachable_without_verified_archive": False,
            "allow_delete_moved_head": False,
        },
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    if any(row.get("classification") == "PRESERVE_ARCHIVE_UNPROVEN" for row in preserved):
        return 2
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository")
    parser.add_argument("--expected-main-sha")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.repository or not args.expected_main_sha:
        parser.error("--repository and --expected-main-sha are required outside --self-test")
    return apply(args.repository, args.expected_main_sha)


if __name__ == "__main__":
    raise SystemExit(main())
