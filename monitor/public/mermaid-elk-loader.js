// ELK 레이아웃 준비 함수 — 5 MB 벤더 번들을 "첫 다이어그램을 그리기 직전"에 한 번만 들여온다.
//
// 왜 파일이 따로 있나: 이 스크립트가 index.html 의 <script src="assets/vendor/…"> 를 대체한다.
// 그 태그는 다이어그램이 하나도 없는 라우트(#dashboard 등)에서도 5,079,669 B 를 동기로 받아
// 첫 페인트를 그만큼 늦췄다. 번들 자체는 그대로 두고(재빌드 없음) 받는 시점만 옮긴 것이다.
//
// 무결성 규율은 대체한 태그와 같다 — 저장소가 배포하는 로컬 파일이라 integrity/crossorigin 속성이
// 아니라 사이드카(assets/vendor/mermaid-layout-elk.provenance.json)의 sha256 이 바이트를 못 박고,
// test/mermaid-elk.vendor-pin.unit.test.ts 가 디스크의 바이트와 사이드카를 대조한다.
// 그래서 여기서 고정해야 하는 것은 "사이드카가 이름을 적은 그 파일 하나"라는 경로 문자열이다.
//
// 소비자는 셋 — 맵 캔버스(architecture.jsx) · 문서 뷰어(clauded-docs.jsx) · 내보내기 드라이버
// (src/server/clauded-docs/html-export.ts). 앞의 둘은 브라우저에서 URL 로 받고, 내보내기는
// 렌더 페이지에 번들 텍스트를 이미 주입한 뒤라 받을 것이 없다 — 그 경우를 아래 "이미 도착함"
// 분기가 받아서, 등록식 하나를 세 경로가 함께 쓰게 한다.
(function () {
	"use strict";

	// 사이드카가 이름을 적은 파일 하나. 여기와 provenance.bundle_file 이 갈라지면 뷰어는 404 를 먹고
	// 조용히 dagre 로 눕는다 — 하네스가 이 문자열을 사이드카와 대조한다.
	var VENDOR_SRC = "assets/vendor/mermaid-layout-elk-0.2.3.min.js";

	// 준비 약속 1개를 기억해 둔다 — 같은 페이지의 둘째 다이어그램이 번들을 다시 받지 않게 하는 것도,
	// registerLayoutLoaders 가 정확히 한 번만 불리게 하는 것도 이 하나의 약속이 보장한다.
	var pending = null;

	// 벤더 IIFE 가 실행되면 window.mermaidLayoutElk 를 남긴다 — 내보내기처럼 번들 텍스트를 직접
	// 주입한 페이지에서는 이미 있으므로 네트워크로 갈 이유가 없다.
	function alreadyArrived() {
		return typeof window.mermaidLayoutElk !== "undefined";
	}

	function injectVendor() {
		return new Promise(function (resolve) {
			var el = document.createElement("script");
			el.src = VENDOR_SRC;
			// 클래식 스크립트 — 모듈 태그는 실행 전에 해석 단계를 거쳐 전역이 늦게 선다.
			el.async = false;
			el.addEventListener("load", function () {
				resolve();
			});
			el.addEventListener("error", function () {
				// 여기서 거부하지 않는다: 대체한 인라인 등록도 `?? []` 로 빈 목록을 넘겨
				// 다이어그램 자체는 dagre 로라도 그리게 했다. 같은 태도를 유지하되,
				// 조용히 눕지는 않도록 한 줄 남긴다(mermaid 의 폴백 경고는 logLevel 3 이 따로 낸다).
				console.warn(
					"[mermaid-elk-loader] " + VENDOR_SRC + " did not load — diagrams will fall back to dagre",
				);
				resolve();
			});
			document.head.appendChild(el);
		});
	}

	function register() {
		// mermaid 전역이 없으면 등록할 대상이 없다 — 렌더도 못 하므로 여기서 끊지 않고 넘긴다.
		// `?? []` 는 대체한 인라인 등록의 의미를 그대로 옮긴 것(번들이 없어도 등록 호출은 성립).
		if (window.mermaid && typeof window.mermaid.registerLayoutLoaders === "function") {
			window.mermaid.registerLayoutLoaders(
				(window.mermaidLayoutElk && window.mermaidLayoutElk.default) || [],
			);
		}
	}

	// 첫 호출이 번들을 받아 등록하고, 이후 호출은 같은 약속을 즉시 돌려준다.
	// 렌더 경로는 mermaid.render 앞에서 이것을 await 한다 — 기다리지 않고 그린 다이어그램은
	// 등록 전이라 dagre 로 눕고, mermaid 가 폴백 경고를 낸다(하네스의 반증 케이스).
	function ensureElkLayout() {
		if (pending) return pending;
		pending = (alreadyArrived() ? Promise.resolve() : injectVendor()).then(register);
		return pending;
	}

	window.ensureElkLayout = ensureElkLayout;
})();
