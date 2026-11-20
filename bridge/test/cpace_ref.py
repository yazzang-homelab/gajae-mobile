#!/usr/bin/env python3
"""Independent CPACE-X25519-SHA512 reference for fixtures/cpace-vector.json (gjcm-code-v1, #128).

Written from the specifications, not from bridge/src/cpace.ts:
  - Elligator 2: RFC 9380 section 6.7.1 (map_to_curve_elligator2 with J = 486662, K = 1, Z = 2)
  - X25519: RFC 7748 section 5 Montgomery ladder (the result is all zero for low-order inputs = abort)
  - generator_string / lv_cat / ISK: draft-irtf-cfrg-cpace-21 appendix A
  - key confirmation: draft section 10.4 with HMAC-SHA512

Reads a JSON request on stdin and writes the answers to stdout. Standard library only.
  {"map": [hex u bytes], "generator": [{"prs","ci","sid"} hex], "x25519": [{"k","u"} hex],
   "transaction": {"prs","ci","sid","ya","yb","ada","adb"} hex}
"""
import hashlib
import hmac
import json
import sys

P = 2**255 - 19
J = 486662
Z = 2


def inv0(x):
    return pow(x % P, P - 2, P)


def is_square(x):
    return pow(x % P, (P - 1) // 2, P) in (0, 1)


def map_to_curve_elligator2(u):
    """RFC 9380 6.7.1, Montgomery u-coordinate only."""
    x1 = (-J * inv0(1 + Z * u * u)) % P
    if x1 == 0:
        x1 = (-J) % P
    gx1 = (x1 * x1 * x1 + J * x1 * x1 + x1) % P
    x2 = (-x1 - J) % P
    return x1 if is_square(gx1) else x2


def decode_u(b):
    b = bytearray(b)
    b[31] &= 0x7F
    return int.from_bytes(bytes(b), "little")


def encode_u(x):
    return (x % P).to_bytes(32, "little")


def decode_scalar(k):
    k = bytearray(k)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    return int.from_bytes(bytes(k), "little")


def cswap(swap, a, b):
    return (b, a) if swap else (a, b)


def x25519(k_bytes, u_bytes):
    """RFC 7748 section 5."""
    k = decode_scalar(k_bytes)
    x1 = decode_u(u_bytes) % P
    x2, z2, x3, z3 = 1, 0, x1, 1
    swap = 0
    a24 = 121665
    for t in reversed(range(255)):
        kt = (k >> t) & 1
        swap ^= kt
        x2, x3 = cswap(swap, x2, x3)
        z2, z3 = cswap(swap, z2, z3)
        swap = kt
        A = (x2 + z2) % P
        AA = A * A % P
        B = (x2 - z2) % P
        BB = B * B % P
        E = (AA - BB) % P
        C = (x3 + z3) % P
        D = (x3 - z3) % P
        DA = D * A % P
        CB = C * B % P
        x3 = (DA + CB) ** 2 % P
        z3 = x1 * (DA - CB) ** 2 % P
        x2 = AA * BB % P
        z2 = E * (AA + a24 * E) % P
    x2, x3 = cswap(swap, x2, x3)
    z2, z3 = cswap(swap, z2, z3)
    return encode_u(x2 * pow(z2, P - 2, P))


def leb128(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def lv_cat(*parts):
    return b"".join(leb128(len(p)) + p for p in parts)


DSI = b"CPace255"


def generator_string(prs, ci, sid, s_in_bytes=128):
    zpad = max(0, s_in_bytes - 1 - len(leb128(len(prs)) + prs) - len(leb128(len(DSI)) + DSI))
    return lv_cat(DSI, prs, bytes(zpad), ci, sid)


def calculate_generator(prs, ci, sid):
    h = hashlib.sha512(generator_string(prs, ci, sid)).digest()[:32]
    return encode_u(map_to_curve_elligator2(decode_u(h)))


def scalar_mult_vfy(k, u):
    out = x25519(k, u)
    return None if out == bytes(32) else out


def transaction(t):
    prs, ci, sid = (bytes.fromhex(t[k]) for k in ("prs", "ci", "sid"))
    ya, yb, ada, adb = (bytes.fromhex(t[k]) for k in ("ya", "yb", "ada", "adb"))
    g = calculate_generator(prs, ci, sid)
    Ya = scalar_mult_vfy(ya, g)
    Yb = scalar_mult_vfy(yb, g)
    K = scalar_mult_vfy(ya, Yb)
    assert K == scalar_mult_vfy(yb, Ya)
    isk = hashlib.sha512(lv_cat(DSI + b"_ISK", sid, K) + lv_cat(Ya, ada) + lv_cat(Yb, adb)).digest()
    mac_key = hashlib.sha512(b"CPaceMac" + sid + isk).digest()
    ta = hmac.new(mac_key, lv_cat(Ya, ada), hashlib.sha512).digest()
    tb = hmac.new(mac_key, lv_cat(Yb, adb), hashlib.sha512).digest()
    return {k: v.hex() for k, v in dict(g=g, Ya=Ya, Yb=Yb, K=K, ISK=isk, Ta=ta, Tb=tb).items()}


def main():
    req = json.load(sys.stdin)
    out = {
        "map": [encode_u(map_to_curve_elligator2(decode_u(bytes.fromhex(u)))).hex() for u in req.get("map", [])],
        "generator": [
            calculate_generator(bytes.fromhex(g["prs"]), bytes.fromhex(g["ci"]), bytes.fromhex(g["sid"])).hex()
            for g in req.get("generator", [])
        ],
        "x25519": [
            (lambda r: r.hex() if r else None)(scalar_mult_vfy(bytes.fromhex(x["k"]), bytes.fromhex(x["u"])))
            for x in req.get("x25519", [])
        ],
    }
    if "transaction" in req:
        out["transaction"] = transaction(req["transaction"])
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
