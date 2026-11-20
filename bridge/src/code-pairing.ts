/**
 * Decisions for a device-code session (gjcm-code-v1, #128), kept pure: (pending rows, event) → (rows to store,
 * answer). `server.ts` runs each one inside `BridgeState.mutatePairings` and does the I/O.
 *
 *   pake          → expired | locked | start (one attempt taken before any key material goes out)
 *   pake.confirm  → ok (code dropped, pairing secret rotated, offer to seal) | wrong{left} | locked | expired
 *
 * Taking the attempt when a session starts (not when its tag turns out wrong) counts every session the bridge
 * computes, so a peer learns nothing from dropping one and gets at most five online guesses per code.
 */
import { b64urlEncode, randomBytes } from "./crypto";
import type { PairingOffer } from "./offer";
import type { PairingsChange, PendingPairing } from "./state";

export const CODE_ATTEMPTS = 5;

export type StartDecision =
	| { kind: "expired" }
	| { kind: "locked" }
	| { kind: "start"; pairingId: string; prs: string; left: number };

export function decideStart(rows: PendingPairing[]): PairingsChange<StartDecision> {
	const row = rows.find(p => p.code);
	if (!row?.code) return { result: { kind: "expired" } };
	if (row.code.attemptsLeft <= 0) return { rows: dropCode(rows, row), result: { kind: "locked" } };
	const left = row.code.attemptsLeft - 1;
	return {
		rows: rows.map(p => (p === row ? { ...p, code: { ...row.code!, attemptsLeft: left } } : p)),
		result: { kind: "start", pairingId: row.id, prs: row.code.prs, left },
	};
}

export type ConfirmDecision =
	| { kind: "ok"; offer: PairingOffer }
	| { kind: "wrong"; left: number }
	| { kind: "locked" }
	| { kind: "expired" };

/**
 * After Ta is checked. The row is looked up again: a newer `pair`, a QR hello, or expiry may have retired the code
 * since the session started, and then even a correct tag gets `expired`.
 */
export function decideConfirm(
	rows: PendingPairing[],
	session: { pairingId: string; prs: string },
	tagOk: boolean,
	rotateSecret: () => string = () => b64urlEncode(randomBytes(32)),
): PairingsChange<ConfirmDecision> {
	const row = rows.find(p => p.id === session.pairingId && p.code?.prs === session.prs);
	if (!row?.code) return { result: { kind: "expired" } };
	if (!tagOk) {
		if (row.code.attemptsLeft <= 0) return { rows: dropCode(rows, row), result: { kind: "locked" } };
		return { result: { kind: "wrong", left: row.code.attemptsLeft } };
	}
	// The QR on the screen carries the old secret: rotating it here retires the QR the moment the code is used.
	const secret = rotateSecret();
	const { code, ...rest } = row;
	const rotated: PendingPairing = { ...rest, secret };
	return {
		rows: rows.map(p => (p === row ? rotated : p)),
		result: { kind: "ok", offer: { ...code.offer, pairingId: row.id, secret, exp: row.expiresAt } },
	};
}

function dropCode(rows: PendingPairing[], row: PendingPairing): PendingPairing[] {
	const { code: _code, ...rest } = row;
	return rows.map(p => (p === row ? rest : p));
}
