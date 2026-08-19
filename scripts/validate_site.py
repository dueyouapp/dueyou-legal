from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_PAGES = [
    "index.html",
    "privacy.html",
    "terms.html",
    "support.html",
    "data-safety.html",
]
ALL_HTML = PUBLIC_PAGES + ["404.html"]
KUCOIN_LAUNCHER = ROOT / "kucoin-monitor" / "index.html"
EXPECTED_BASE = "https://dueyouapp.github.io/dueyou-legal/"


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []
        self.lang: str | None = None
        self.titles = 0
        self.h1s = 0
        self.viewport = False
        self.canonical: str | None = None
        self.robots: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = dict(attrs)
        if tag == "html":
            self.lang = data.get("lang")
        elif tag == "title":
            self.titles += 1
        elif tag == "h1":
            self.h1s += 1
        elif tag == "a" and data.get("href"):
            self.hrefs.append(data["href"] or "")
        elif tag == "meta":
            name = (data.get("name") or "").lower()
            if name == "viewport":
                self.viewport = True
            elif name == "robots":
                self.robots = data.get("content")
        elif tag == "link" and (data.get("rel") or "").lower() == "canonical":
            self.canonical = data.get("href")


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def validate_html(errors: list[str]) -> None:
    for name in ALL_HTML:
        path = ROOT / name
        if not path.exists():
            fail(errors, f"missing HTML page: {name}")
            continue

        text = path.read_text(encoding="utf-8")
        parser = PageParser()
        parser.feed(text)

        if parser.lang != "en-IE":
            fail(errors, f"{name}: html lang must be en-IE")
        if parser.titles != 1:
            fail(errors, f"{name}: expected exactly one <title>, found {parser.titles}")
        if parser.h1s != 1:
            fail(errors, f"{name}: expected exactly one <h1>, found {parser.h1s}")
        if not parser.viewport:
            fail(errors, f"{name}: missing viewport meta tag")

        if name in PUBLIC_PAGES:
            if not parser.canonical:
                fail(errors, f"{name}: missing canonical URL")
            elif not parser.canonical.startswith(EXPECTED_BASE):
                fail(errors, f"{name}: canonical URL is outside the published site")
        elif name == "404.html":
            robots = (parser.robots or "").replace(" ", "").lower()
            if "noindex" not in robots:
                fail(errors, "404.html: must include a noindex robots directive")

        forbidden_markers = ("TODO", "CHANGEME", "REPLACE_ME", "example.com")
        for marker in forbidden_markers:
            if marker in text:
                fail(errors, f"{name}: unresolved placeholder marker {marker!r}")

        for href in parser.hrefs:
            if href.startswith(("mailto:", "tel:", "#")):
                continue
            parsed = urlparse(href)
            if parsed.scheme:
                if parsed.scheme != "https":
                    fail(errors, f"{name}: external link must use HTTPS: {href}")
                continue

            target = parsed.path
            if not target:
                continue
            if target.endswith("/"):
                target = target + "index.html"
            candidate = (ROOT / target).resolve()
            try:
                candidate.relative_to(ROOT.resolve())
            except ValueError:
                fail(errors, f"{name}: link escapes site root: {href}")
                continue
            if not candidate.exists():
                fail(errors, f"{name}: broken internal link: {href}")


def validate_kucoin_launcher(errors: list[str]) -> None:
    if not KUCOIN_LAUNCHER.exists():
        fail(errors, "kucoin-monitor/index.html: missing private launcher")
        return

    text = KUCOIN_LAUNCHER.read_text(encoding="utf-8")
    lower = text.lower()

    required = (
        "LAUNCHER V4.4",
        "kucoin-monitor-github-read-token-v1",
        "applyKnownV4Compatibility",
        "validateDashboard",
        "v4LauncherHandshake",
        "Contents: Read-only",
    )
    for marker in required:
        if marker not in text:
            fail(errors, f"kucoin-monitor/index.html: missing launcher contract marker {marker!r}")

    # HTML script parsing terminates on a literal closing-script sentinel even
    # when that text appears inside a JavaScript string. The launcher therefore
    # must contain exactly one real closing tag: the tag that closes its own
    # inline JavaScript block. Runtime-injected tags are assembled from pieces.
    closing_count = lower.count("</script>")
    if closing_count != 1:
        fail(
            errors,
            "kucoin-monitor/index.html: expected exactly one literal </script> "
            f"sentinel, found {closing_count}",
        )

    script_open = lower.find("<script>")
    script_close = lower.rfind("</script>")
    if script_open < 0 or script_close <= script_open:
        fail(errors, "kucoin-monitor/index.html: inline launcher script boundary is invalid")
        return

    javascript = text[script_open + len("<script>") : script_close]
    if not javascript.strip():
        fail(errors, "kucoin-monitor/index.html: inline launcher JavaScript is empty")
        return

    node = shutil.which("node")
    if not node:
        fail(errors, "kucoin-monitor/index.html: Node.js is required for launcher syntax validation")
        return

    completed = subprocess.run(
        [node, "--check", "-"],
        input=javascript,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        fail(errors, f"kucoin-monitor/index.html: launcher JavaScript syntax error: {detail}")


def validate_sitemap(errors: list[str]) -> None:
    path = ROOT / "sitemap.xml"
    try:
        tree = ET.parse(path)
    except Exception as exc:
        fail(errors, f"sitemap.xml: invalid XML: {exc}")
        return

    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = {node.text for node in tree.findall("sm:url/sm:loc", ns) if node.text}
    expected = {
        EXPECTED_BASE,
        *(EXPECTED_BASE + name for name in PUBLIC_PAGES if name != "index.html"),
    }
    missing = expected - locs
    unexpected = locs - expected
    if missing:
        fail(errors, f"sitemap.xml: missing URLs: {sorted(missing)}")
    if unexpected:
        fail(errors, f"sitemap.xml: unexpected URLs: {sorted(unexpected)}")


def validate_robots(errors: list[str]) -> None:
    text = (ROOT / "robots.txt").read_text(encoding="utf-8")
    expected = f"Sitemap: {EXPECTED_BASE}sitemap.xml"
    if expected not in text:
        fail(errors, "robots.txt: sitemap URL does not match published site")


def main() -> int:
    errors: list[str] = []
    validate_html(errors)
    validate_kucoin_launcher(errors)
    validate_sitemap(errors)
    validate_robots(errors)

    if errors:
        print("Site validation FAILED:")
        for item in errors:
            print(f"- {item}")
        return 1

    print(
        f"Site validation passed for {len(ALL_HTML)} legal pages "
        "and the KuCoin private launcher."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
