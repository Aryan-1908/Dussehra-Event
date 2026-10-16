"""Ravan Dahan self-hosted server.

Serves ravan-dahan.html as a normal web page and stands in for the claude.ai
runtime the page was written for: a WebSocket hub for the live room (taps,
quiz answers, reactions, host state), the team vow wall, and player names.

Run:  PORT=8000 python server.py
Host link is printed at startup (and kept in data/host_key).
"""
import asyncio
import json
import os
import re
import secrets
import time
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "ravan-dahan.html"
SHIM = ROOT / "shim.js"
DATA = ROOT / "data"
STATE_FILE = DATA / "state.json"
KEY_FILE = DATA / "host_key"
PORT = int(os.environ.get("PORT", "8000"))

ADMIN_TOPICS = {"state", "dahan"}               # only the host may send these
HOST_ONLY_TOPICS = {"tap", "answer", "react"}   # only the host screen needs these
TOPIC_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,47}$")
ID_RE = re.compile(r"^u_[A-Za-z0-9]{8,40}$")
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_DATA = 4096

DATA.mkdir(exist_ok=True)
HOST_KEY = os.environ.get("HOST_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
if not HOST_KEY:
    HOST_KEY = secrets.token_urlsafe(9)
KEY_FILE.write_text(HOST_KEY)

try:
    _saved = json.loads(STATE_FILE.read_text())
except (OSError, ValueError):
    _saved = {}
vows: dict = _saved.get("vows", {})
names: dict = _saved.get("names", {})
approved: set = set(_saved.get("approved", []))
rejected: set = set()
auto = {"on": os.environ.get("AUTO_APPROVE") == "1"}
round_no = {"n": int(_saved.get("round", 1))}
clients: dict = {}  # ws -> client info

HEAD = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    "{title}"
    "<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}"
    "body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>"
    '<script src="/shim.js"></script></head><body>'
)


def save_state():
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"vows": vows, "names": names, "approved": sorted(approved), "round": round_no["n"]}))
    tmp.replace(STATE_FILE)


def clean_text(v, n):
    return CTRL_RE.sub("", str(v or "")).strip()[:n]


def clean_vow(d):
    if not isinstance(d, dict):
        return None

    def num(k, lo, hi):
        v = d.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return max(lo, min(hi, int(v)))

    return {
        "vow": clean_text(d.get("vow"), 48),
        "burns": num("burns", 0, 100000) or 0,
        "bestArrows": num("bestArrows", 1, 10000),
        "bestSec": num("bestSec", 1, 100000),
        "bestMs": num("bestMs", 500, 3600000),
        "heads": num("heads", 0, 10),
        "timedOut": bool(d.get("timedOut")),
        "updatedAt": int(time.time() * 1000),
    }


def vows_list():
    return [{"id": k, "data": v} for k, v in vows.items()]


def peers_list():
    return [{"peer": c["peer"], "by": c["id"], "presence": c["presence"]}
            for c in clients.values() if c["id"] and c["approved"]]


def pending_list():
    seen, out = set(), []
    for c in clients.values():
        i = c["id"]
        if i and not c["approved"] and i not in rejected and i not in seen:
            seen.add(i)
            out.append({"id": i, "name": names.get(i, "")})
    return out


async def send_to(targets, obj):
    text = json.dumps(obj)
    await asyncio.gather(*(ws.send_str(text) for ws in targets if not ws.closed), return_exceptions=True)


async def broadcast(obj, hosts_only=False):
    targets = [ws for ws, c in clients.items() if c["id"] and c["approved"] and (c["host"] or not hosts_only)]
    await send_to(targets, obj)


async def notify_hosts():
    hosts = [ws for ws, c in clients.items() if c["host"] and c["id"]]
    await send_to(hosts, {"t": "pending", "list": pending_list(), "auto": auto["on"]})


def welcome(c):
    full = c["approved"]
    return {"t": "welcome", "peer": c["peer"], "id": c["id"], "isHost": c["host"], "approved": full,
            "names": names if full else {}, "vows": vows_list() if full else [], "peers": peers_list() if full else [],
            "pending": pending_list() if c["host"] else [], "auto": auto["on"], "round": round_no["n"]}


async def admit(ws, c):
    c["approved"] = True
    approved.add(c["id"])
    rejected.discard(c["id"])
    save_state()
    await send_to([ws], welcome(c))
    await broadcast({"t": "peers", "peers": peers_list()})
    await broadcast({"t": "names", "names": names})


async def handle(ws, c, m):
    t = m.get("t")
    if t == "hello":
        cid = m.get("id")
        c["id"] = cid if isinstance(cid, str) and ID_RE.match(cid) else "u_" + secrets.token_hex(10)
        c["host"] = secrets.compare_digest(str(m.get("hostKey") or ""), HOST_KEY)
        nm = clean_text(m.get("name"), 32)
        if nm:
            names[c["id"]] = nm
            save_state()
        c["approved"] = c["host"] or auto["on"] or c["id"] in approved
        if c["approved"]:
            approved.add(c["id"])
        await send_to([ws], welcome(c))
        if c["id"] in rejected and not c["approved"]:
            await send_to([ws], {"t": "rejected"})
        if c["approved"]:
            await broadcast({"t": "peers", "peers": peers_list()})
            if nm:
                await broadcast({"t": "names", "names": names})
        await notify_hosts()
        return
    if not c["id"]:
        return
    if t == "name":
        nm = clean_text(m.get("name"), 32)
        if nm:
            names[c["id"]] = nm
            save_state()
            if c["approved"]:
                await broadcast({"t": "names", "names": names})
            await notify_hosts()
        return
    if t in ("approve", "reject", "auto") and c["host"]:
        if t == "auto":
            auto["on"] = bool(m.get("on"))
            if auto["on"]:
                for ows, oc in list(clients.items()):
                    if oc["id"] and not oc["approved"]:
                        await admit(ows, oc)
        else:
            want = m.get("ids")
            for ows, oc in list(clients.items()):
                if not oc["id"] or oc["approved"]:
                    continue
                if t == "approve" and (m.get("all") or (isinstance(want, list) and oc["id"] in want)):
                    await admit(ows, oc)
                elif t == "reject" and isinstance(want, list) and oc["id"] in want:
                    rejected.add(oc["id"])
                    await send_to([ows], {"t": "rejected"})
        await notify_hosts()
        return
    if not c["approved"]:
        return
    if t == "emit":
        topic = m.get("topic")
        if not isinstance(topic, str) or not TOPIC_RE.match(topic):
            return
        if topic in ADMIN_TOPICS and not c["host"]:
            return
        data = m.get("data")
        if len(json.dumps(data)) > MAX_DATA:
            return
        await broadcast({"t": "msg", "topic": topic, "data": data, "peer": c["peer"], "by": c["id"]},
                        hosts_only=topic in HOST_ONLY_TOPICS)
    elif t == "presence":
        patch = m.get("patch")
        if not isinstance(patch, dict):
            return
        merged = dict(c["presence"])
        for k, v in patch.items():
            if v is None:
                merged.pop(k, None)
            else:
                merged[str(k)[:64]] = v
        if len(json.dumps(merged)) <= MAX_DATA:
            c["presence"] = merged
            await broadcast({"t": "peers", "peers": peers_list()})
    elif t == "resetboard":
        if c["host"]:
            for v in vows.values():
                v.update({"burns": 0, "bestArrows": None, "bestSec": None, "bestMs": None, "heads": None, "timedOut": False})
            round_no["n"] += 1
            save_state()
            await broadcast({"t": "round", "round": round_no["n"]})
            await broadcast({"t": "vows", "vows": vows_list()})
    elif t == "vow":
        v = clean_vow(m.get("data"))
        if v is not None:
            vows[c["id"]] = v
            save_state()
            await broadcast({"t": "vows", "vows": vows_list()})


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=16384)
    await ws.prepare(request)
    c = {"peer": secrets.token_hex(8), "id": None, "host": False, "approved": False, "presence": {}, "tokens": 50.0, "ts": time.monotonic()}
    clients[ws] = c
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            now = time.monotonic()  # token bucket: ~25 messages/s, burst 50
            c["tokens"] = min(50.0, c["tokens"] + (now - c["ts"]) * 25)
            c["ts"] = now
            if c["tokens"] < 1:
                continue
            c["tokens"] -= 1
            try:
                m = json.loads(msg.data)
            except ValueError:
                continue
            if isinstance(m, dict):
                await handle(ws, c, m)
    finally:
        clients.pop(ws, None)
        if c["id"]:
            await broadcast({"t": "peers", "peers": peers_list()})
            await notify_hosts()
    return ws


async def page(request):
    body = PAGE.read_text(encoding="utf-8")
    m = re.search(r"<title>.*?</title>", body, re.S)
    title = m.group(0) if m else "<title>Ravan Dahan</title>"
    if m:
        body = body[: m.start()] + body[m.end():]
    html = HEAD.format(title=title) + body + "</body></html>"
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})


async def shim(request):
    return web.Response(text=SHIM.read_text(encoding="utf-8"), content_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


async def health(request):
    return web.json_response({"ok": True, "online": len(clients)})


app = web.Application()
app.router.add_get("/", page)
app.router.add_get("/shim.js", shim)
app.router.add_get("/ws", ws_handler)
app.router.add_get("/healthz", health)

if __name__ == "__main__":
    print(f"Ravan Dahan running on http://localhost:{PORT}", flush=True)
    print(f"Host link: http://localhost:{PORT}/?host={HOST_KEY}", flush=True)
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)
