import base64
import hashlib
import json
import logging
import os
import re
from pathlib import Path

from openai import OpenAI
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)


QWEN_PROMPT = """
Analyze the provided image and determine if it contains input fields associated with the login flow of a web page. Specifically, look for:

Username or email input fields (e.g., forms with user ID, unique user ID, email address, or similar fields).
Password input fields (fields intended for password entry).
Follow this structured approach:

Identify all input fields in the image.
Filter out irrelevant input fields, such as those related to search, comments, or non-login-related data collection.
Determine if at least one relevant login-related input field is present and visible on the page.
Explain your reasoning step by step (Chain of Thought) to justify your decision.
Strictly output either "YES" or "NO" at the end, based on whether a login form containing at least one relevant input field is detected.
Output Format (Important):
After explaining your reasoning, respond strictly with either:

"YES" (if a relevant login input field is present and visible).
"NO" (if no relevant login input field is found).
"""

POPUP_PROMPT = """
Analyze the provided image and determine if there are any visible popups or cookie banners.
If a popup is detected, where do I click to close it. Give me the coordinates of a cross icon in order to close it. If this does not exist give me the coordinates of the button inside the popup that exists
If a cookie banner is detected return the position of the large Accept button inside a colored shape, for example oval or square.
If no popup or cookie banner exists Output: "No popups found".
Output Format:

Element Type: [Popup/Cookie Banner]
Description: [Brief description]
Bounding Box Coordinates: (x1, y1, x2, y2)
Guidelines:
- Only focus on popups or cookie banners.
- Provide precise bounding box coordinates.
"""

LOGIN_BUTTON_PROMPT = """
Analyze the provided image and identify where do I click to access the login page.
This may be an element labeled abstractly like Online Banking, My Account, Login or a person icon or even a form submit button associated with login credentials etc.
Output Format:

Element Type: Login Button
Description: [Brief description]
Bounding Box Coordinates: (x1, y1, x2, y2)
Guidelines:
- Only focus on the element that takes me to the login page.
- Provide precise bounding box coordinates.
"""


QWEN_BASE_URL = os.environ.get("QWEN_BASE_URL")
QWEN_API_KEY = os.environ.get("QWEN_API_KEY", "token-abc123")
QWEN_MODEL = os.environ.get("QWEN_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")

OS_ATLAS_BASE_URL = os.environ.get("OS_ATLAS_BASE_URL")
OS_ATLAS_API_KEY = os.environ.get("OS_ATLAS_API_KEY", "token-abc123")
OS_ATLAS_MODEL = os.environ.get("OS_ATLAS_MODEL", "OS-Copilot/OS-Atlas-Base-7B")

VLM_CACHE_MODE = os.environ.get("VLM_CACHE_MODE", "live_with_fallback")
VLM_CACHE_PATH = os.environ.get("VLM_CACHE_PATH", "/app/data/vlm_cache.json")
OVERLAY_ENABLED = os.environ.get("LOGINGPT_OVERLAY_CLICKS", "true").lower() == "true"


class VLMUnavailable(Exception):
    pass


_cache = None


def _load_cache():
    global _cache
    if _cache is None:
        p = Path(VLM_CACHE_PATH)
        _cache = json.loads(p.read_text()) if p.exists() else {}
    return _cache


def _key(image_bytes, prompt):
    return hashlib.sha256(image_bytes).hexdigest() + ":" + hashlib.sha256(prompt.encode()).hexdigest()[:16]


def _read_b64(path):
    data = Path(path).read_bytes()
    return data, "data:image/png;base64," + base64.b64encode(data).decode()


def _call_with_fallback(key, live_fn, transform):
    if VLM_CACHE_MODE == "cache_only":
        cached = _load_cache().get(key)
        if cached is None:
            raise VLMUnavailable(f"cache miss: {key}")
        return transform(cached)
    try:
        return live_fn()
    except VLMUnavailable:
        raise
    except Exception as e:
        if VLM_CACHE_MODE == "live_only":
            raise
        logger.warning(f"VLM live call failed, falling back to cache: {e}")
        cached = _load_cache().get(key)
        if cached is None:
            raise VLMUnavailable(f"live failed and cache miss: {e}")
        return transform(cached)


def classify_login_page(screenshot_path: str) -> bool:
    img_bytes, img_url = _read_b64(screenshot_path)
    key = _key(img_bytes, QWEN_PROMPT)

    def live():
        if not QWEN_BASE_URL:
            raise VLMUnavailable("QWEN_BASE_URL not set")
        client = OpenAI(base_url=QWEN_BASE_URL, api_key=QWEN_API_KEY)
        r = client.chat.completions.create(
            model=QWEN_MODEL,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": img_url}},
                    {"type": "text", "text": QWEN_PROMPT},
                ]},
            ],
            max_tokens=512,
        )
        text = r.choices[0].message.content.strip()
        matches = re.findall(r"\b(YES|NO)\b", text, re.IGNORECASE)
        return bool(matches and matches[-1].upper() == "YES")

    return _call_with_fallback(key, live, bool)


def ground_element(screenshot_path: str, prompt: str) -> tuple[int, int] | None:
    img_bytes, img_url = _read_b64(screenshot_path)
    key = _key(img_bytes, prompt)

    def live():
        if not OS_ATLAS_BASE_URL:
            raise VLMUnavailable("OS_ATLAS_BASE_URL not set")
        client = OpenAI(base_url=OS_ATLAS_BASE_URL, api_key=OS_ATLAS_API_KEY)
        r = client.chat.completions.create(
            model=OS_ATLAS_MODEL,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": img_url}},
                    {"type": "text", "text": prompt},
                ]},
            ],
            max_tokens=512,
            temperature=0.01,
            top_p=0.001,
        )
        text = r.choices[0].message.content.strip()
        if "No popups found" in text:
            return None
        m = re.search(r"\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", text)
        if not m:
            return None
        x1, y1, x2, y2 = map(int, m.groups())
        with Image.open(screenshot_path) as im:
            w, h = im.size
        return (int((x1 + x2) / 2 * w / 1000), int((y1 + y2) / 2 * h / 1000))

    return _call_with_fallback(key, live, lambda v: tuple(v) if v else None)


def overlay_click_position(screenshot_path: str, coords: tuple[int, int]) -> str:
    if not OVERLAY_ENABLED:
        return screenshot_path
    out = str(Path(screenshot_path).with_suffix(".clicked.png"))
    with Image.open(screenshot_path) as im:
        im = im.convert("RGB")
        d = ImageDraw.Draw(im)
        x, y = coords
        r = 14
        d.ellipse((x - r, y - r, x + r, y + r), outline="red", width=4)
        d.line((x - r, y, x + r, y), fill="red", width=3)
        d.line((x, y - r, x, y + r), fill="red", width=3)
        im.save(out)
    return out
