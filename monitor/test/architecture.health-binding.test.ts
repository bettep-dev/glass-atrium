// PART_NODE_BINDINGS 단위 테스트 (B2-2) — 헬스 부품 명부와 그려지는 지도를 맞대는 지배 계기.
// 부품 하나가 늘거나 노드 하나가 빠지면 붉어짐: 커버리지가 예산을 대신해 볼륨을 지킴 (ADR-14).
// Runner: npx tsx --test test/architecture.health-binding.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "../src/generated/prisma/client.js";

import {
	CANONICAL_MAP,
	DAEMON_NODE_BINDINGS,
	PART_NODE_BINDINGS,
} from "../src/server/architecture/diagrams-source.js";
import { getMermaidCensus } from "../src/server/architecture/content-budget.js";
import {
	getLiveOverlay,
	resetOverlayCache,
	type OverlayLogger,
} from "../src/server/architecture/live-overlay.js";

interface HealthCardDef {
	id: string;
	kind: string;
	daemonName?: string;
}
interface HealthModelApi {
	HEALTH_CARD_DEFS: HealthCardDef[];
}

// health-model.js 는 호출 시점에 window.UI 를 읽고 자기 자신을 window 에 등록함 — 먼저 스텁함.
// (architecture.daemon-binding.test.ts 의 같은 본. 명부를 여기 다시 적으면 계기가 사본을 재게 됨.)
(globalThis as { window?: unknown }).window = { UI: {} };
await import("../public/src/data/health-model.js");
const registeredHealthModel = (globalThis as { window?: { HealthModel?: HealthModelApi } }).window
	?.HealthModel;
assert.ok(registeredHealthModel, "health-model.js must register window.HealthModel");
const HealthModel: HealthModelApi = registeredHealthModel;

// 그려지는 단 한 편의 노드 집합 — 커버리지의 계수 단위 (payload 노드 집합이 아님: 존 id 가
// payload 노드로 등록되므로 존을 부품 노드로 오인하는 경로가 그쪽에만 있음).
const DRAWN_NODE_IDS = new Set(
	getMermaidCensus(CANONICAL_MAP.mermaid_drawn).nodes.map((node) => node.id),
);

function getDrawnProjection(nodeIds: readonly string[]): string[] {
	return nodeIds.filter((nodeId) => DRAWN_NODE_IDS.has(nodeId));
}

test("AC-B2-2a every bound part node id is drawn", () => {
	for (const [partId, nodeIds] of Object.entries(PART_NODE_BINDINGS)) {
		for (const nodeId of nodeIds) {
			assert.ok(
				DRAWN_NODE_IDS.has(nodeId),
				`part '${partId}' binds node id '${nodeId}' which the canonical map does not draw`,
			);
		}
	}
});

test("AC-B2-2b the binding table covers the health part roster, every part non-empty", () => {
	const partIds = HealthModel.HEALTH_CARD_DEFS.map((def) => def.id);
	assert.deepStrictEqual(
		Object.keys(PART_NODE_BINDINGS).sort(),
		[...partIds].sort(),
		"PART_NODE_BINDINGS keys must mirror HEALTH_CARD_DEFS ids",
	);
	for (const partId of partIds) {
		assert.ok(
			(PART_NODE_BINDINGS[partId] ?? []).length >= 1,
			`part '${partId}' has no drawn node — an empty list is a coverage failure, not a declaration`,
		);
	}
});

test("AC-B2-2c the live overlay carries the server table as part_bindings", async () => {
	const degraded: string[] = [];
	const logger: OverlayLogger = {
		warn: (obj: object) => degraded.push(String((obj as { signal?: string }).signal)),
		info: () => {},
	};
	// PG 신호는 전부 degrade 시킴 — 재는 것은 전송이지 데몬 판정이 아님.
	resetOverlayCache();
	const overlay = await getLiveOverlay({} as unknown as PrismaClient, logger);
	resetOverlayCache();

	assert.deepStrictEqual(overlay.part_bindings, PART_NODE_BINDINGS);
});

test("AC-B2-2d daemon parts carry the drawn projection of the daemon binding table", () => {
	const daemonDefs = HealthModel.HEALTH_CARD_DEFS.filter((def) => def.kind === "daemon");
	assert.equal(daemonDefs.length, 4, "the roster must still carry four daemon parts");

	for (const def of daemonDefs) {
		const daemonName = def.daemonName as string;
		const projection = getDrawnProjection(DAEMON_NODE_BINDINGS[daemonName] ?? []);
		// 공허 방지 — 양변이 함께 비면 등식은 아무것도 재지 않음 (ADR-19 잔여 위험).
		assert.ok(
			projection.length >= 1,
			`daemon '${daemonName}' projects to no drawn node — the equality below would be vacuous`,
		);
		assert.deepStrictEqual(
			[...(PART_NODE_BINDINGS[def.id] ?? [])],
			projection,
			`part '${def.id}' must carry the drawn projection of DAEMON_NODE_BINDINGS['${daemonName}']`,
		);
	}
});
