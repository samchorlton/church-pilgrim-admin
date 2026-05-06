#!/usr/bin/env python3
import json
import re
import sys
import time
import urllib.parse
import urllib.request

USER_AGENT = "church-pilgrim/1.0 (python wikimedia resolver)"
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

try:
    from curl_cffi import requests as curl_requests  # type: ignore
except Exception:
    curl_requests = None


def http_get_json(url):
    if curl_requests is not None:
        for attempt in range(3):
            try:
                resp = curl_requests.get(
                    url,
                    headers={"User-Agent": USER_AGENT},
                    impersonate="safari",
                    timeout=15,
                    proxies={},
                )
            except Exception:
                break
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code != 429:
                return None
            time.sleep(0.4 * (attempt + 1))

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with NO_PROXY_OPENER.open(req, timeout=12) as response:
                if response.status != 200:
                    return None
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            if attempt == 2:
                return None
            time.sleep(0.4 * (attempt + 1))
    return None


def normalize_text(value):
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def fetch_wikipedia_thumbnail_by_title(title):
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "prop": "pageimages",
            "pithumbsize": "1200",
            "pilicense": "any",
            "redirects": "1",
            "titles": title,
            "origin": "*",
        }
    )
    data = http_get_json(f"https://en.wikipedia.org/w/api.php?{params}")
    if not data:
        return None
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        source = ((page or {}).get("thumbnail") or {}).get("source")
        if source:
            return source
    return None


def search_wikipedia_titles(query):
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": query,
            "srlimit": "5",
            "origin": "*",
        }
    )
    data = http_get_json(f"https://en.wikipedia.org/w/api.php?{params}")
    if not data:
        return []
    return [item.get("title") for item in (data.get("query", {}).get("search") or []) if item.get("title")]


def search_commons_categories(query):
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": query,
            "srnamespace": "14",
            "srlimit": "5",
            "origin": "*",
        }
    )
    data = http_get_json(f"https://commons.wikimedia.org/w/api.php?{params}")
    if not data:
        return []
    out = []
    for item in data.get("query", {}).get("search") or []:
        title = str(item.get("title") or "")
        out.append(re.sub(r"^Category:", "", title, flags=re.I).strip())
    return [v for v in out if v]


def fetch_first_commons_category_image(category):
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "generator": "categorymembers",
            "gcmtitle": f"Category:{category}",
            "gcmtype": "file",
            "gcmlimit": "1",
            "prop": "imageinfo",
            "iiprop": "url",
            "origin": "*",
        }
    )
    data = http_get_json(f"https://commons.wikimedia.org/w/api.php?{params}")
    if not data:
        return None
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        infos = (page or {}).get("imageinfo") or []
        if infos and infos[0].get("url"):
            return infos[0].get("url")
    return None


def fetch_first_commons_image_by_search(query):
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrlimit": "1",
            "gsrsearch": query,
            "gsrnamespace": "6",
            "prop": "imageinfo",
            "iiprop": "url",
            "origin": "*",
        }
    )
    data = http_get_json(f"https://commons.wikimedia.org/w/api.php?{params}")
    if not data:
        return None
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        infos = (page or {}).get("imageinfo") or []
        if infos and infos[0].get("url"):
            return infos[0].get("url")
    return None


def resolve(name, subtitle):
    normalized_name = str(name or "").split(",")[0].strip()
    locality = str(subtitle or "").strip()
    has_locality = locality and locality.lower() != "england"

    direct_titles = [
        f"{normalized_name}, {locality}" if has_locality else normalized_name,
        f"{normalized_name} ({locality})" if has_locality else normalized_name,
        f"{normalized_name} church",
        f"{normalized_name} church {locality}" if has_locality else f"{normalized_name} church England",
        f"{normalized_name} cathedral",
        f"{normalized_name} {locality} England" if has_locality else f"{normalized_name} England",
    ]

    for title in direct_titles:
        image = fetch_wikipedia_thumbnail_by_title(title)
        if image:
            return image

    search_queries = [
        f"{normalized_name} {locality} church England" if has_locality else f"{normalized_name} church England",
        f"{normalized_name} {locality} listed building" if has_locality else f"{normalized_name} listed building England",
        f"{normalized_name} {locality}" if has_locality else normalized_name,
    ]

    seen_titles = set()
    for query in search_queries:
        for title in search_wikipedia_titles(query):
            if title in seen_titles:
                continue
            seen_titles.add(title)
            image = fetch_wikipedia_thumbnail_by_title(title)
            if image:
                return image

    seen_categories = set()
    for query in search_queries:
        for category in search_commons_categories(query):
            key = normalize_text(category)
            if key in seen_categories:
                continue
            seen_categories.add(key)
            image = fetch_first_commons_category_image(category)
            if image:
                return image

    commons_file_queries = [
        f"{normalized_name} ({locality})" if has_locality else normalized_name,
        f"{normalized_name} {locality}" if has_locality else f"{normalized_name} church",
        f"{normalized_name} church {locality}" if has_locality else f"{normalized_name} church",
    ]
    for query in commons_file_queries:
        image = fetch_first_commons_image_by_search(query)
        if image:
            return image

    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        payload = {}
    name = payload.get("name")
    subtitle = payload.get("subtitle")
    image = resolve(name, subtitle)
    sys.stdout.write(json.dumps({"image": image}))


if __name__ == "__main__":
    main()
