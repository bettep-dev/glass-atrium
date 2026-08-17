// 거버넌스 멤버십 표면 — 컴플라이언스 매트릭스가 이름으로 선언한 scope/rule 문서가 라이브에 실재하는지 확인.
//
// 총계가 아니라 "사라진 파일 이름" 을 내보내는 것이 요점이다: 숫자 배지는 무엇이 없어졌는지 말해주지 못한다.
// 기대 이름 집합은 매트릭스 문서에서 파싱한다 — 디렉터리 나열로 뽑으면 항상 자기 자신과 일치해 아무것도 잡지 못한다.
// 매트릭스 자체를 못 읽으면 그 사실을 sourceMissing 으로 surface — silent absorb 금지.

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTtlCache } from "./ttl-cache.js";

export interface MembershipLogger {
	warn(obj: object, msg?: string): void;
	info(obj: object, msg?: string): void;
}

export interface GovernanceMembership {
	// 매트릭스가 이름을 댔지만 라이브에 없는 문서의 아트리움 상대 경로 (정렬됨).
	absent: string[];
	// 기대 이름 집합의 출처 문서를 읽지 못함 — absent 는 이 경우 판정 불가라 비어 있다.
	sourceMissing: boolean;
}

const ATRIUM_ROOT = join(homedir(), ".glass-atrium");
const MATRIX_RELATIVE = join("rules", "glass-atrium", "core-compliance-matrix.md");

// 매트릭스가 인라인 코드로 적는 문서 경로 형태 (`scoped/scope-dev.md` 등).
const DECLARED_PATH = /`((?:scoped|rules\/glass-atrium|agents)\/[\w.-]+\.md)`/g;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Root-parameterised core — the test seam; production always passes the live Atrium root. */
export async function getMembershipAt(
	root: string,
	log: MembershipLogger,
): Promise<GovernanceMembership> {
	const matrixPath = join(root, MATRIX_RELATIVE);
	let matrix: string;
	try {
		matrix = await readFile(matrixPath, "utf8");
	} catch (error) {
		log.warn(
			{ err: error, path: matrixPath },
			"governance membership: matrix read failed",
		);
		return { absent: [], sourceMissing: true };
	}

	const declared = [
		...new Set([...matrix.matchAll(DECLARED_PATH)].map((m) => m[1] as string)),
	].sort();
	const absent: string[] = [];
	for (const relative of declared) {
		if (!(await exists(join(root, relative)))) absent.push(relative);
	}

	log.info(
		{ declared: declared.length, absent },
		"governance membership computed",
	);
	return { absent, sourceMissing: false };
}

// 파일 존재 확인은 희소하게만 변하는데 /api/architecture/live 는 고빈도 → 드리프트와 같은 TTL 로 캐시.
const membershipCache = createTtlCache(30_000, (log: MembershipLogger) =>
	getMembershipAt(ATRIUM_ROOT, log),
);

export function computeGovernanceMembership(
	log: MembershipLogger,
): Promise<GovernanceMembership> {
	return membershipCache.get(log);
}

/** Test seam — clears the membership cache so the next call re-reads the filesystem. */
export function resetGovernanceMembershipCache(): void {
	membershipCache.reset();
}
