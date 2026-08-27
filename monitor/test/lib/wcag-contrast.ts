// WCAG 2.1 relative-luminance contrast, shared by the token unit test (parsed
// triplets) and the map e2e (computed colours off a live canvas). One definition:
// a second copy drifts silently, since both sides only ever assert on the ratio.

import assert from "node:assert/strict";

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** `rgb(12, 10, 9)` / `rgba(…)` 등 계산된 색 문자열 → 채널. 알파가 없으면 1. */
export function parseColor(value: string): Rgba {
	const nums = (value.match(/-?\d*\.?\d+/g) ?? []).map(Number);
	assert.ok(nums.length >= 3, `computed colour "${value}" is not an rgb()/rgba() triplet`);
	return { r: nums[0], g: nums[1], b: nums[2], a: nums.length > 3 ? nums[3] : 1 };
}

/** 반투명 stroke 는 자기 면 위에 합성한 뒤라야 대비를 말할 수 있다. */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
	return {
		r: bg.r + (fg.r - bg.r) * fg.a,
		g: bg.g + (fg.g - bg.g) * fg.a,
		b: bg.b + (fg.b - bg.b) * fg.a,
		a: 1,
	};
}

/** sRGB → linear transfer function, then WCAG 2.1 relative luminance. */
export function relativeLuminance(c: Rgba): number {
	const channel = [c.r, c.g, c.b].map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2];
}

/** (L_light + 0.05) / (L_dark + 0.05) — order-independent. */
export function contrastRatio(a: Rgba, b: Rgba): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
