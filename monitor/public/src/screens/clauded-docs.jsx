// 클로드 문서 관리 화면 — window.ScreenClaudedDocs 로 app.jsx Screens lookup 에 등록.
//
// 뷰어 본문 보안 — 2-layer sanitize (server DOMPurify→SHA256, client 재-sanitize→DOMParser→React 트리).
//   · iframe sandbox 미사용 사유 — 본문이 Tailwind CDN JIT 의존 → sandbox 가 script 차단 시 utility class no-op.
//   · <style> 글로벌 셀렉터는 .doc-body-isolation 컨테이너로 prefix scoping.
//
// 데이터 모델:
//   - audience (exposed/hidden) — legacy row 는 ops/public/agent-only 값이 도착할 수 있어 read-side normalize.
//   - html_path  — monitor 내부 FS 경로 (사용자 직접 접근 X — viewer 경유).
const {
	useState: useStateCD,
	useEffect: useEffectCD,
	useRef: useRefCD,
	useCallback: useCallbackCD,
} = React;

// doc_status 2-state — progress=작업 중 / done=완료. '' = 필터 미적용.
const DOC_STATUS_OPTIONS_CD = [
	{ value: "", label: "All", desc: "Documents in any status" },
	{
		value: "progress",
		label: "In progress",
		desc: "Still being worked on",
	},
	{
		value: "done",
		label: "Done",
		desc: "Finished",
	},
];

// doc_status chip 색상 — progress=warn(in-flight) / done=ok(완료) / ''=faint.
const DOC_STATUS_CSS_VAR_CD = {
	"": "--faint",
	progress: "--warn",
	done: "--ok",
};

// format 배지 데이터 — doc.format 실값으로 dual-encode (색 + glyph). html 외 포맷은 agent-only 변종.
const DOC_FORMAT_BADGE_CD = {
	html: {
		glyph: "H",
		label: "Web page",
		desc: "Web page",
	},
	md: {
		glyph: "M",
		label: "MD",
	},
	yaml: {
		glyph: "Y",
		label: "YAML",
	},
	json: {
		glyph: "J",
		label: "JSON",
	},
	txt: {
		glyph: "T",
		label: "TXT",
	},
};

// audience 필터 — 서버 audience 2값 {exposed, hidden} 매핑 (null → 'exposed' 처리).
const AUDIENCE_OPTIONS_CD = [
	{ value: "all", label: "All" },
	{ value: "visible", label: "For people" },
	{ value: "agent-only", label: "Agent-only" },
];

const SEARCH_DEBOUNCE_MS_CD = 250;

const LIST_LIMIT_CD = 50;
const SEARCH_LIMIT_CD = 50;

const TOAST_DURATION_MS_CD = 3200;

// 2-step delete — 첫 클릭 = pending, 윈도우 내 2번째 클릭 = 실제 삭제.
const DELETE_CONFIRM_WINDOW_MS_CD = 3000;

// 그룹 expand 상태 localStorage 키 — folder_id JSON array 로 세션 간 펼침 상태 유지.
const GROUP_EXPAND_STORAGE_KEY_CD = "clauded-docs.group-expand.v1";

// group 만들기 최소 멤버 수 (server contract 정합).
const GROUP_MIN_MEMBERS_CD = 2;

// 메인 화면
function ScreenClaudedDocs(/* { onNav } */) {
	const { PageHeader, Icon, Pill, Badge, TypeScaleStyle, DetailSurface } =
		window.UI;

	// 검색어 / 필터.
	const [keyword, setKeyword] = useStateCD("");
	const [debouncedQ, setDebouncedQ] = useStateCD("");
	// doc_status 1차 필터 (전체/진행중/완료). default 'progress' — 신규 진입 시 작업 중 항목 우선 surface.
	//   · /groups endpoint 의 ?doc_status= 송신용 — rows endpoint 는 미지원 (search mode 제외).
	const [docStatusFilter, setDocStatusFilter] = useStateCD("progress");
	const [audienceFilter, setAudienceFilter] = useStateCD("all");

	// 목록 / 뷰어 / 폼 상태.
	// listState.data.rows 는 server 최근 응답만 보유 · 누적 표시 행은 loadedRows 별도 array (Load More append 패턴).
	const [listState, setListState] = useStateCD({
		status: "loading",
		data: null,
		error: null,
	});
	// Load More 페이지네이션 누적 array. filter/검색 변경 시 [] 리셋 + offset=0 fetch.
	const [loadedRows, setLoadedRows] = useStateCD([]);
	const [currentOffset, setCurrentOffset] = useStateCD(0);
	const [selectedId, setSelectedId] = useStateCD(null);
	const [viewerState, setViewerState] = useStateCD({
		status: "idle",
		data: null,
		error: null,
	});
	// 편집 진입점만 유지 — 신규 작성은 agent emission (POST /api/clauded-docs) 단일 경로.
	const [editorOpen, setEditorOpen] = useStateCD(null); // null | { seed }
	const [pendingDelete, setPendingDelete] = useStateCD(null); // { id, expiresAt }
	const [refreshTick, setRefreshTick] = useStateCD(0);
	const [toast, setToast] = useStateCD(null); // { tone, message }

	// doc_status 토글 optimistic state map.
	//   · togglingIds: Set<number> — PUT in-flight 인 id (aria-busy + 클릭 차단).
	//   · optimisticStatusOverrides: Map<number, 'progress'|'done'> — 응답 도착 전 강제 표시 값.
	//   · 응답 성공 → triggerRefresh 가 새 row.doc_status 로 덮어쓴 뒤 entry 삭제 · 실패 → entry 삭제 = 자동 rollback.
	//   · setter 는 항상 새 Set / 새 Map 반환 (React 식별).
	const [togglingIds, setTogglingIds] = useStateCD(() => new Set());
	const [optimisticStatusOverrides, setOptimisticStatusOverrides] = useStateCD(
		() => new Map(),
	);

	// multi-select 상태. Set<number> · row leading checkbox 토글. setter 는 항상 새 Set 반환 (React 식별).
	//   · filter / 검색 / refresh 변경 시 자동 clear (의도치 않은 사이드이펙트 회피 — deps effect 아래).
	const [selectedIds, setSelectedIds] = useStateCD(() => new Set());

	// group expand 상태 (folder_id 기준). localStorage hydrate — JSON array → Set 복원, 실패 시 빈 Set (콘솔 warn).
	const [expandedFolderIds, setExpandedFolderIds] = useStateCD(() => {
		try {
			const raw = window.localStorage.getItem(GROUP_EXPAND_STORAGE_KEY_CD);
			if (!raw) return new Set();
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return new Set();
			return new Set(parsed.filter((id) => typeof id === "number" && id > 0));
		} catch (err) {
			console.warn(
				"[clauded-docs] group-expand localStorage hydrate failed",
				err,
			);
			return new Set();
		}
	});

	// 전체화면 토글 — CSS-only position:fixed · 네이티브 Fullscreen API 미사용 (iframe sandbox 우회 방지).
	const [isFullscreen, setIsFullscreen] = useStateCD(false);

	// AbortController — 목록 / 뷰어 fetch 독립 취소.
	const listAbortRef = useRefCD(null);
	const viewerAbortRef = useRefCD(null);
	const toastTimerRef = useRefCD(null);
	const deleteTimerRef = useRefCD(null);

	const triggerRefresh = useCallbackCD(() => setRefreshTick((t) => t + 1), []);

	const showToast = useCallbackCD((tone, message) => {
		setToast({ tone, message });
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		toastTimerRef.current = setTimeout(
			() => setToast(null),
			TOAST_DURATION_MS_CD,
		);
	}, []);

	// 전체화면 f/F 토글 단축키 — Esc 닫기 · Tab focus-trap · 진입 포커스는 DetailSurface 계약으로 위임.
	//   - selectedId null → fullscreen 자동 해제 (빈 풀스크린 회피).
	//   - F 토글: 편집 입력 포커스 시 비활성 (INPUT/TEXTAREA/contentEditable 충돌 회피).
	//   - F 닫기 시 selectedId 도 비움 → 목록-only 로 복귀.
	useEffectCD(() => {
		if (selectedId == null && isFullscreen) {
			setIsFullscreen(false);
			return;
		}
		const onKey = (e) => {
			const t = e.target;
			const isEditing =
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			if (
				!isEditing &&
				(e.key === "f" || e.key === "F") &&
				selectedId != null &&
				!editorOpen
			) {
				e.preventDefault();
				if (isFullscreen) {
					setIsFullscreen(false);
					setSelectedId(null);
				} else {
					setIsFullscreen(true);
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isFullscreen, selectedId, editorOpen]);

	// 검색어 debounce — 250ms 후 적용. AbortController 로 in-flight 취소.
	useEffectCD(() => {
		const id = setTimeout(
			() => setDebouncedQ(keyword.trim()),
			SEARCH_DEBOUNCE_MS_CD,
		);
		return () => clearTimeout(id);
	}, [keyword]);

	// 필터/검색 변경 = 페이지 초기화 — offset=0 리셋 + loadedRows clear.
	//   · fetch effect (아래) 가 currentOffset 포함 deps 로 작동 → offset 리셋이 자동 트리거.
	useEffectCD(() => {
		setCurrentOffset(0);
		setLoadedRows([]);
	}, [debouncedQ, docStatusFilter, refreshTick]);

	// filter / refresh 변경 시 multi-select clear — chip 토글 = "다른 목록 보기" → 이전 선택 의미 소멸.
	useEffectCD(() => {
		setSelectedIds(new Set());
	}, [debouncedQ, docStatusFilter, refreshTick]);

	// expandedFolderIds 변경 시 localStorage 영속화 (JSON array) — 실패 시 silent (quota / private mode).
	useEffectCD(() => {
		try {
			window.localStorage.setItem(
				GROUP_EXPAND_STORAGE_KEY_CD,
				JSON.stringify(Array.from(expandedFolderIds)),
			);
		} catch (err) {
			// QuotaExceededError / SecurityError (private mode) — 세션 한정 동작 보존.
			console.warn("[clauded-docs] group-expand localStorage persist failed", err);
		}
	}, [expandedFolderIds]);

	// 목록 / 검색 fetch — debouncedQ 비면 list (groups endpoint), 있으면 search (rows endpoint).
	//   · offset=0 응답 → loadedRows 교체, offset>0 응답 → loadedRows append (Load More).
	//   · search mode (q 존재) — offset 무시 (search endpoint 페이지네이션 미지원, 단일 page 응답).
	//   · groups endpoint = group → rows-like 정규화 (representative_* → row.*) → 단일/다건 동일 shape 렌더로 UI 분기 최소화.
	useEffectCD(() => {
		const ctrl = new AbortController();
		listAbortRef.current?.abort();
		listAbortRef.current = ctrl;

		// search mode 는 offset 무시 — buildListUrlCD 가 q 있을 시 search endpoint 진입 + offset 미사용.
		const isLoadMore = currentOffset > 0 && !debouncedQ;
		// 첫 페이지 fetch 시만 skeleton — Load More 는 기존 행 유지 + 별도 버튼 spinner.
		if (!isLoadMore) {
			setListState({ status: "loading", data: null, error: null });
		}

		const managedUrl = buildListUrlCD({
			q: debouncedQ,
			docStatus: docStatusFilter,
			offset: currentOffset,
		});

		fetchJsonCD(managedUrl, ctrl.signal)
			.then((managedData) => {
				if (ctrl.signal.aborted) return;
				// /groups endpoint → groups[] 정규화 · /search 또는 rows endpoint → rows[] 직접 사용.
				// normalizeGroupToRowCD 가 invalid group 에 대해 null 반환 → flatMap 으로 drop (방어).
				const rows = Array.isArray(managedData?.groups)
					? managedData.groups.flatMap((g) => {
							const r = normalizeGroupToRowCD(g);
							return r == null ? [] : [r];
						})
					: Array.isArray(managedData?.rows)
						? managedData.rows
						: [];
				const total = Number(managedData?.total ?? rows.length);
				// groups 응답 한정 서버 집계 (doc-level 건수 + audience hidden 전체 건수) — search rows 응답엔 부재 → null.
				const docTotal =
					typeof managedData?.doc_total === "number"
						? managedData.doc_total
						: null;
				const hiddenDocTotal =
					typeof managedData?.hidden_doc_total === "number"
						? managedData.hidden_doc_total
						: null;
				// search 응답 한정 — false = pg_bigm 부재 (한글 부분일치 저하) · groups 응답엔 부재 → null.
				const bigmEnabled =
					typeof managedData?.bigm_enabled === "boolean"
						? managedData.bigm_enabled
						: null;
				setListState({
					status: "ready",
					data: { rows, total, docTotal, hiddenDocTotal, bigmEnabled },
					error: null,
				});
				// Load More — 기존 누적 + 신규 page · 첫 페이지 / search — 교체.
				setLoadedRows((prev) => (isLoadMore ? prev.concat(rows) : rows));
			})
			.catch((err) => {
				if (err && err.name === "AbortError") return;
				setListState({
					status: "error",
					data: null,
					error: err?.message || String(err),
				});
			});

		return () => ctrl.abort();
	}, [debouncedQ, docStatusFilter, refreshTick, currentOffset]);

	// Load More callback — 단순 setter. 이미 fetch 중이면 호출 무시 (무한 루프 방지).
	const loadMore = useCallbackCD(() => {
		if (listState.status === "loading") return;
		if (debouncedQ) return; // search mode 미지원
		const visibleLen = loadedRows.length;
		const total =
			listState.status === "ready" ? Number(listState.data?.total ?? 0) : 0;
		if (visibleLen >= total) return; // 더 가져올 페이지 없음
		setCurrentOffset(visibleLen);
	}, [listState, debouncedQ, loadedRows.length]);

	// 뷰어 본문 fetch — format query 생략 → 서버 default resolution (rowFormat 자동 감지) 활용.
	//   · HTML primary / 비-HTML primary (md) / agent-only MD·YAML·JSON·TXT 모두 format 그대로 응답.
	//   · 신규 selectedId / PUT 후 강제 재조회 공용.
	const loadViewerCD = useCallbackCD((id) => {
		const ctrl = new AbortController();
		viewerAbortRef.current?.abort();
		viewerAbortRef.current = ctrl;
		setViewerState({ status: "loading", data: null, error: null });
		fetchJsonCD(`/api/clauded-docs/${encodeURIComponent(id)}`, ctrl.signal)
			.then((data) => setViewerState({ status: "ready", data, error: null }))
			.catch((err) => handleErrorCD(err, setViewerState));
		return ctrl;
	}, []);

	// selectedId 변경 시 뷰어 fetch (row 유형별 default resolution).
	useEffectCD(() => {
		if (selectedId == null) {
			setViewerState({ status: "idle", data: null, error: null });
			return;
		}
		const ctrl = loadViewerCD(selectedId);
		return () => ctrl.abort();
	}, [selectedId, loadViewerCD]);

	// 정리 — unmount 시 toast / deleteConfirm 타이머 해제.
	useEffectCD(
		() => () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
			if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
		},
		[],
	);

	// write actions — POST 는 agent emission 단일 진입 (UI create 핸들러 없음) · 사용자 진입점은 PUT (편집) 만.

	const performUpdate = useCallbackCD(
		async (id, body) => {
			showToast("info", "Saving…");
			try {
				const res = await fetch(`/api/clauded-docs/${encodeURIComponent(id)}`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Couldn't save — ${reason}`);
					return false;
				}
				showToast("ok", `Saved #${id}`);
				setEditorOpen(null);
				triggerRefresh();
				// viewer 가 동일 id 면 강제 재조회.
				if (selectedId === id) loadViewerCD(id);
				return true;
			} catch (err) {
				showToast("crit", `Couldn't save — ${err?.message || err}`);
				return false;
			}
		},
		[selectedId, showToast, triggerRefresh, loadViewerCD],
	);

	const performDeleteImpl = useCallbackCD(
		async (id) => {
			showToast("info", "Deleting…");
			try {
				const res = await fetch(`/api/clauded-docs/${encodeURIComponent(id)}`, {
					method: "DELETE",
					headers: { Accept: "application/json" },
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Couldn't delete — ${reason}`);
					return;
				}
				showToast("ok", `Deleted #${id}`);
				if (selectedId === id) setSelectedId(null);
				triggerRefresh();
			} catch (err) {
				showToast("crit", `Couldn't delete — ${err?.message || err}`);
			}
		},
		[selectedId, showToast, triggerRefresh],
	);

	// 2-step delete — 1st click 이면 pending state 진입 (3초 윈도우), 동일 id 2nd click 이면 실제 DELETE.
	const requestDelete = useCallbackCD(
		(id) => {
			if (
				pendingDelete &&
				pendingDelete.id === id &&
				Date.now() < pendingDelete.expiresAt
			) {
				void performDeleteImpl(id);
				setPendingDelete(null);
				if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
				return;
			}
			setPendingDelete({
				id,
				expiresAt: Date.now() + DELETE_CONFIRM_WINDOW_MS_CD,
			});
			if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
			deleteTimerRef.current = setTimeout(
				() => setPendingDelete(null),
				DELETE_CONFIRM_WINDOW_MS_CD,
			);
		},
		[pendingDelete, performDeleteImpl],
	);

	// POST /api/clauded-docs/group · member_ids ≥ 2.
	//   · 성공 → toast + selection clear + list refresh · 실패 → describeApiErrorCD 매핑 + selection 유지 (재시도 가능).
	const performGroupCreate = useCallbackCD(
		async (memberIds) => {
			if (memberIds.length < GROUP_MIN_MEMBERS_CD) {
				showToast(
					"warn",
					`Select at least ${GROUP_MIN_MEMBERS_CD} documents to group`,
				);
				return false;
			}
			showToast("info", "Grouping…");
			try {
				const res = await fetch("/api/clauded-docs/group", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({ member_ids: memberIds }),
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Couldn't group — ${reason}`);
					return false;
				}
				const count = Number(payload?.member_count ?? memberIds.length);
				showToast("ok", `Grouped ${count}`);
				setSelectedIds(new Set());
				triggerRefresh();
				return true;
			} catch (err) {
				showToast("crit", `Couldn't group — ${err?.message || err}`);
				return false;
			}
		},
		[showToast, triggerRefresh],
	);

	// POST /api/clauded-docs/ungroup · member_ids ≥ 1.
	//   · auto_ungrouped_ids surface — server 가 1-member 남은 source group 자동 해제.
	const performUngroup = useCallbackCD(
		async (memberIds) => {
			if (memberIds.length < 1) {
				showToast("warn", "Select documents to ungroup");
				return false;
			}
			showToast("info", "Ungrouping…");
			try {
				const res = await fetch("/api/clauded-docs/ungroup", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({ member_ids: memberIds }),
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Couldn't ungroup — ${reason}`);
					return false;
				}
				const count = Number(payload?.ungrouped_count ?? memberIds.length);
				const autoIds = Array.isArray(payload?.auto_ungrouped_ids)
					? payload.auto_ungrouped_ids
					: [];
				const autoNote =
					autoIds.length > 0 ? ` (incl. ${autoIds.length} auto-ungrouped)` : "";
				showToast("ok", `Ungrouped ${count}${autoNote}`);
				setSelectedIds(new Set());
				triggerRefresh();
				return true;
			} catch (err) {
				showToast("crit", `Couldn't ungroup — ${err?.message || err}`);
				return false;
			}
		},
		[showToast, triggerRefresh],
	);

	// HTML 묶음 내려받기 — POST /api/clauded-docs/html-export → zip blob 다운로드.
	//   · 50건 초과 → 서버 400 반환 전 클라이언트 guard (버튼 disabled 로 1차 차단)
	//   · 성공 → blob URL 생성 → 임시 <a> 클릭 → revokeObjectURL (메모리 정리)
	//   · 부분 포함 (X-Included-Count < 요청 수) → warn toast — 200 만으로 전건 성공 가장 금지
	//   · 전건 실패 → 서버가 zip 대신 export_failed JSON (404/503) → crit toast
	//   · 실패 → describeApiErrorCD + crit toast (silent fallback 금지)
	const exportSelectionAsZip = useCallbackCD(async () => {
		const ids = Array.from(selectedIds);
		if (ids.length === 0 || ids.length > 50) return;
		showToast("info", `Downloading ${ids.length} as HTML…`);
		try {
			const res = await fetch("/api/clauded-docs/html-export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids }),
			});
			if (!res.ok) {
				const payload = await res.json().catch(() => null);
				const reason = describeApiErrorCD(payload, res.status);
				showToast("crit", `Download failed — ${reason}`);
				return;
			}
			// 서버가 zip 에 실제 포함한 문서 수 — 헤더 부재(구버전 서버) 시 전건 포함으로 간주.
			const includedRaw = res.headers.get("x-included-count");
			const included = includedRaw === null ? ids.length : Number(includedRaw);
			const blob = await res.blob();
			const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `clauded-docs-${today}.zip`;
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
			if (Number.isFinite(included) && included < ids.length) {
				showToast(
					"warn",
					`Only ${included} of ${ids.length} included — see _manifest.json inside the zip for why`,
				);
			} else {
				showToast("ok", `Downloaded ${ids.length} as zip`);
			}
		} catch (err) {
			showToast("crit", `Download failed — ${err?.message || err}`);
		}
	}, [selectedIds, showToast]);

	// 드래그앤드롭 멤버 재정렬 영속화. PATCH /api/clauded-docs/group/:rootId/reorder.
	//   · orderedIds = rootId 그룹의 전체 멤버 id (representative 포함) 를 visual 순서 그대로 나열.
	//     서버 set-equality 검증이 folder_id == rootId 전체 집합을 요구 → representative 누락 시 400 missing_ids.
	//     rep 도 임의 위치 가능 (서버는 order-0 멤버를 새 representative 로 선정).
	//   · 낙관적 갱신은 GroupMembersRowsCD 측에서 로컬 처리 · 본 핸들러는 PATCH 송신 + 토스트 + boolean 반환만 담당.
	//   · 성공 → triggerRefresh — order-0 멤버 변경 시 representative 도 바뀌어 접힌 그룹 헤더 제목 갱신 위해 /groups 재조회 필수.
	const performReorder = useCallbackCD(
		async (rootId, orderedIds) => {
			try {
				const res = await fetch(
					`/api/clauded-docs/group/${encodeURIComponent(rootId)}/reorder`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
						},
						body: JSON.stringify({ ordered_ids: orderedIds }),
					},
				);
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Order not saved — ${reason}`);
					return false;
				}
				showToast("ok", "Order saved");
				triggerRefresh();
				return true;
			} catch (err) {
				showToast("crit", `Order not saved — ${err?.message || err}`);
				return false;
			}
		},
		[showToast, triggerRefresh],
	);

	// doc_status 1-click 토글 핸들러 — optimistic update 채용.
	//   사유: status 토글은 binary flip · blast radius 단일 행 → latency wait-state 가 wrong trade-off (다른 write 핸들러의 pessimistic 과 다른 패턴).
	//   진행 순서:
	//     1) togglingIds 진입 + optimisticStatusOverrides 즉시 flip (UI instant feedback)
	//     2) cachedRow 가 같은 id 면 GET 스킵 — 그 외 GET /:id 로 body + content_hash + format 확보 (/groups 응답의 content_hash 는 null)
	//     3) PUT /:id — body echoed (서버 'body unchanged + status diff' cascade-only path)
	//     4) ok → triggerRefresh + toast · viewer 동일 id 면 재조회 / 실패 → toast + optimistic 자동 rollback (entry 삭제)
	//   동일 id 중복 클릭 차단 — togglingIds 멤버 시 early return.
	const performStatusToggle = useCallbackCD(
		async (id, currentStatus, cachedRow) => {
			// 입력 가드 — 알 수 없는 상태 / 진행 중 토글 차단.
			if (currentStatus !== "progress" && currentStatus !== "done") {
				showToast("warn", `Unknown status — can't toggle (#${id})`);
				return false;
			}
			if (togglingIds.has(id)) return false;

			const targetStatus = currentStatus === "progress" ? "done" : "progress";

			// Optimistic flip + in-flight 표시.
			setTogglingIds((prev) => {
				const next = new Set(prev);
				next.add(id);
				return next;
			});
			setOptimisticStatusOverrides((prev) => {
				const next = new Map(prev);
				next.set(id, targetStatus);
				return next;
			});

			// Rollback helper — 응답 실패 시 in-flight + optimistic 동시 정리 (entry 삭제 = 원래 row.doc_status 복귀).
			const rollback = () => {
				setTogglingIds((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
				setOptimisticStatusOverrides((prev) => {
					const next = new Map(prev);
					next.delete(id);
					return next;
				});
			};

			try {
				// 1) row 의 body + content_hash + format 확보. viewer cache 가 같은 id 면 GET 스킵 (네트워크 절감).
				let body, expectedHash, format;
				if (
					cachedRow &&
					cachedRow.id === id &&
					typeof cachedRow.body === "string" &&
					typeof cachedRow.content_hash === "string" &&
					typeof cachedRow.format === "string"
				) {
					body = cachedRow.body;
					expectedHash = cachedRow.content_hash;
					format = cachedRow.format;
				} else {
					const fetched = await fetchJsonCD(
						`/api/clauded-docs/${encodeURIComponent(id)}`,
					);
					body = fetched.body;
					expectedHash = fetched.content_hash;
					format = fetched.format;
				}

				// 2) format → body field name (서버 parseUpdateBody 5-way discriminator 정합).
				const bodyFieldName =
					format === "html"
						? "html_body"
						: format === "md"
							? "md_body"
							: format === "yaml"
								? "yaml_body"
								: format === "json"
									? "json_body"
									: "txt_body";

				// 3) PUT — body echo + status flip. expected_hash 로 optimistic-lock 보존.
				const res = await fetch(`/api/clauded-docs/${encodeURIComponent(id)}`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({
						expected_hash: expectedHash,
						doc_status: targetStatus,
						[bodyFieldName]: body,
					}),
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok) {
					// 409 / 400 / 404 / 5xx — describeApiErrorCD 매핑 + rollback.
					const reason = describeApiErrorCD(payload, res.status);
					showToast("crit", `Couldn't change status — ${reason}`);
					rollback();
					return false;
				}

				// 성공 — refresh 가 새 row.doc_status 를 반영하므로 optimistic entry 정리만 수행.
				//   · togglingIds 제거 (in-flight 해제).
				//   · optimisticStatusOverrides 제거 — refresh 직후 row.doc_status 가 SoT.
				setTogglingIds((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
				setOptimisticStatusOverrides((prev) => {
					const next = new Map(prev);
					next.delete(id);
					return next;
				});
				const successLabel =
					targetStatus === "done" ? "marked done" : "marked in progress";
				showToast("ok", `#${id} ${successLabel}`);
				triggerRefresh();
				// viewer 가 동일 id 면 강제 재조회 (메타 패널 doc_status badge 즉시 갱신).
				if (selectedId === id) loadViewerCD(id);
				return true;
			} catch (err) {
				showToast("crit", `Couldn't change status — ${err?.message || err}`);
				rollback();
				return false;
			}
		},
		[togglingIds, selectedId, showToast, triggerRefresh, loadViewerCD],
	);

	// multi-select toggle. checkbox 토글 · setter 는 항상 새 Set 반환.
	const toggleSelection = useCallbackCD((id) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// group expand toggle (folder_id 기준). localStorage 자동 영속 (effect).
	const toggleExpand = useCallbackCD((folderId) => {
		setExpandedFolderIds((prev) => {
			const next = new Set(prev);
			if (next.has(folderId)) next.delete(folderId);
			else next.add(folderId);
			return next;
		});
	}, []);

	// 파생 데이터
	const isSearchMode = debouncedQ.length > 0;
	// loadedRows = Load More 누적 array. search mode 는 단일 page = listState rows.
	const rows = isSearchMode
		? listState.status === "ready"
			? (listState.data?.rows ?? [])
			: []
		: loadedRows;
	const visibleRows = buildVisibleRowsCD(rows, audienceFilter);
	const total =
		listState.status === "ready" ? Number(listState.data?.total ?? 0) : 0;
	// groups 응답 서버 집계 — total 은 그룹 단위 · docTotal 은 문서 단위 (search mode 는 null).
	const docTotal =
		listState.status === "ready" ? (listState.data?.docTotal ?? null) : null;
	const hiddenDocTotal =
		listState.status === "ready"
			? (listState.data?.hiddenDocTotal ?? null)
			: null;
	// visible 모드만 숨은 건수 노출 — 'all' / 'agent-only' 은 가시화 의도라 0 표시.
	// 서버 전체 집계(hidden_doc_total) 우선 — 로드된 page 차감 방식은 미로드분 누락 (F40) · search fallback 만 page 기반.
	const hiddenCount =
		audienceFilter === "visible"
			? hiddenDocTotal != null
				? hiddenDocTotal
				: Math.max(0, rows.length - visibleRows.length)
			: 0;
	// Load More 버튼 가시성. search mode 미지원 + 누적 < total 일 때만 노출.
	const canLoadMore =
		!isSearchMode && listState.status === "ready" && rows.length < total;
	const loadMoreRemaining = canLoadMore ? Math.max(0, total - rows.length) : 0;
	const isLoadingMore = listState.status === "loading" && currentOffset > 0;

	// 카운트 표기 — groups mode 는 그룹/문서 이중 단위 명시 (총건 pill 이 그룹 수를 문서 수처럼 읽히던 오해 차단, F40) ·
	// search mode 는 row 단위 '건' 유지 + 숨은 건 있으면 "표시/전체" 이중 표기 (데이터 정직성).
	const headerRight = (
		<>
			<button
				type="button"
				className="btn ghost sm"
				onClick={triggerRefresh}
				aria-label="Refresh documents"
			>
				<Icon name="refresh" size={13} />
				Refresh
			</button>
		</>
	);

	return (
		<div className="flex flex-col min-h-0 flex-1">
			{/* 타입 스케일 토큰 (ui.jsx SoT) — 멱등 마운트. .fs-* 유틸 + --fs-* CSS var 공급. */}
			<TypeScaleStyle />
			<style>{`
        @keyframes skelPulseCD { 0%,100%{opacity:.7} 50%{opacity:.35} }
        .doc-row { transition: background 100ms; }
        .doc-row:hover { background: rgb(var(--accent) / 0.06); }
        /* title-cell 레이아웃 — 고정폭 leading slot(20px) + 제목 main(flex).
           사유 — chevron toggle 이 group-root 행에만 있어 일반/멤버 행은 제목 시작 x 가 어긋남.
           모든 행에 동일폭 slot 예약 → 제목 컬럼 정렬 통일 + 행 높이 차이 제거.
           2줄분 min-height 를 행에 예약(텍스트 요소 아님) + align-items:center →
           1줄 제목도 예약 높이 내 수직 중앙 정렬(타 셀과 baseline 일치, 상단 부유 제거). */
        .title-cell .doc-title-row { display: flex; align-items: center; gap: 6px; min-height: calc(var(--fs-title) * 1.4 * 2); }
        .doc-title-lead { flex: 0 0 20px; width: 20px; display: flex; align-items: center; justify-content: center; min-height: 20px; }
        .doc-title-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px; }
        /* 제목 텍스트 — line-clamp-2 클램프.
           사유 — 2줄 초과 시 말줄임. 높이 예약은 행(.doc-title-row)으로 이관 →
           텍스트는 콘텐츠 높이만 차지(1줄=1줄 높이), 점프 방지는 행 min-height 가 담당.
           break-word 로 긴 식별자도 안전 래핑. */
        .doc-title-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; overflow-wrap: anywhere; word-break: break-word; }
        /* 표 셀 2차 정보 텍스트 (작성자/날짜/랭크) — meta 레벨 토큰 통일 (ad-hoc text-[11/11.5px] 대체). */
        .doc-meta-text { font-size: var(--fs-meta); }
        .doc-meta-text-mono { font-size: var(--fs-meta); font-family: 'JetBrains Mono', monospace; }
        /* 선택 행 강조 — 2px 좌측 border accent only (S5: full-row flood 금지 · bg fill 제거).
           대비 보조 = 좌측 막대 폭을 3→4px 로 굵혀 fill 제거에 따른 식별성 손실 보상. */
        .doc-row.is-selected { box-shadow: inset 4px 0 0 rgb(var(--accent)); }
        .doc-row.is-pending-delete { box-shadow: inset 4px 0 0 rgb(var(--crit)); }
        .doc-snippet mark { background: rgb(var(--warn) / 0.28); color: rgb(var(--ink)); padding: 0 2px; border-radius: 2px; }
        /* R6 본문 컨테이너 — iframe 자리 대체.
           스크롤 양도 — overflow:visible + height:auto → 문서가 자기 <body>{...} 룰을 .doc-body-isolation 으로 rescope 할 때 동일 selector·동일 specificity 후순위 승리로 overflow 를 visible 재설정해 wrap 의 overflow-y 를 무력화하던 회귀 차단(스크롤 컨테이너를 .doc-fs-body-wrap 으로 이관).
           CARVE-OUT(rgb 9 9 11) — --surface(warm 12 10 9) 미사용은 의도적. 문서 자체 bg-zinc-950 과 hue·값을 정확히 일치시켜 cascade 비결정성 제거 (cool zinc reading palette). --surface 교체 시 hue 불일치 + 결정성 붕괴 → swap 금지.
           행간·자간 base default — 승리값은 specificity 높은 .doc-fs-body-inner > .doc-body-isolation 에 위치(아래) · 여기 base 는 문서 leading 부재 시 fallback. */
        .doc-body-isolation { width: 100%; height: auto; min-height: 0; flex: 1 1 auto; overflow: visible; background: rgb(9 9 11); border-radius: 0; box-shadow: none; box-sizing: border-box; line-height: 1.7; letter-spacing: 0.01em; }
        .doc-meta-row { display: grid; grid-template-columns: 88px 1fr; gap: 6px; padding: 4px 0; font-size: var(--fs-meta); }
        .doc-meta-label { font-family: 'JetBrains Mono', monospace; font-size: var(--fs-micro); color: rgb(var(--faint)); text-transform: uppercase; letter-spacing: 0.04em; }
        .doc-meta-value { color: rgb(var(--ink)); word-break: break-all; font-size: var(--fs-meta); }
        .doc-chip-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; font-size: var(--fs-micro); font-weight: 500; border-radius: 4px; font-family: 'JetBrains Mono', monospace; line-height: 1.4; white-space: nowrap; cursor: pointer; }
        .doc-chip-badge[disabled] { cursor: default; }
        .doc-search-input { width: 100%; padding: 7px 10px 7px 32px; font-size: var(--fs-title); background: rgb(var(--surface)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--ink)); font-family: 'Pretendard Variable', Pretendard, ui-sans-serif, system-ui, sans-serif; }
        .doc-search-input:focus { outline: none; border-color: rgb(var(--accent)); box-shadow: 0 0 0 2px rgb(var(--accent) / 0.2); }
        /* .doc-toast → shared SoT in base.css (model-config 2nd consumer) */
        .doc-empty { padding: 28px; border: 1px dashed rgb(var(--faint) / 0.5); border-radius: 8px; color: rgb(var(--faint)); text-align: center; font-family: 'JetBrains Mono', monospace; font-size: var(--fs-body); }
        .doc-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); pointer-events: none; color: rgb(var(--faint)); }
        .doc-editor-input { width: 100%; padding: 8px 10px; font-size: var(--fs-title); background: rgb(var(--surface)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--ink)); }
        .doc-editor-input:focus { outline: none; border-color: rgb(var(--accent)); box-shadow: 0 0 0 2px rgb(var(--accent) / 0.2); }
        .doc-editor-textarea { width: 100%; min-height: 320px; max-height: 60vh; padding: 10px 12px; font-size: 12.5px; background: rgb(var(--surface)); border: 1px solid rgb(var(--line)); border-radius: 6px; color: rgb(var(--ink)); font-family: 'JetBrains Mono', monospace; line-height: 1.55; resize: vertical; }
        .doc-editor-textarea:focus { outline: none; border-color: rgb(var(--accent)); box-shadow: 0 0 0 2px rgb(var(--accent) / 0.2); }
        /* (retired) format('H')/audience/format-row/chain 표시 배지 — 전부 canonical window.UI.Badge 로 이전, screen-local CSS 미사용분 제거. */
        /* version-history (T-DOC-3) — base.css .acked 는 .alert-row 스코프라 div 미적용 → predecessor 전용 dim 룰.
           current=강조 / predecessor=.acked(opacity 0.5) 시각 구분. summary chevron 은 native 유지. */
        .doc-revision-predecessor.acked { opacity: 0.5; }
        .doc-version-history > summary { list-style: revert; }
        /* superseded 문서 배너 — 구 revision 열람 중임을 본문 위에서 경고 (stale 문서에 owner 가 액션하는 사고 차단, F34). */
        .doc-superseded-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 16px; background: rgb(var(--warn) / 0.12); border-bottom: 1px solid rgb(var(--warn) / 0.4); color: rgb(var(--warn)); font-size: var(--fs-body); font-weight: 500; }
        /* code viewer (yaml/json/txt) — dark base (bg-zinc-900 + border-zinc-800).
           github-dark.min.css 가 .hljs span.hljs-* 토큰 색상 부여 — 본 컨테이너는 chrome (배경/테두리/패딩/폰트) 만 정의. */
        .doc-code-pre { margin: 16px 0; padding: 16px; background: rgb(24 24 27); border: 1px solid rgb(39 39 42); border-radius: 6px; overflow-x: auto; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace; font-size: 13px; line-height: 1.6; color: rgb(228 228 231); }
        .doc-code-pre code { background: transparent; padding: 0; font-family: inherit; font-size: inherit; line-height: inherit; display: block; white-space: pre; }
        /* 전체화면 reading 면 — DetailSurface variant='fullscreen' bare panel 로 마운트 (overlay/backdrop/focus-trap/scroll-lock/Esc 닫기/z 계약은 공용 .detail-overlay).
           .detail-fullscreen 스코프로 specificity(0,2,0) 승격 → .detail-fullscreen .detail-panel(0,2,0) 의 max-width 980 / border / fade 애니메이션을 source-order 후순위로 제압, 불투명 zinc full-bleed 면 보존.
           100vw × 100dvh (mobile dynamic viewport 정합) · border-radius 0 (fullscreen 자체가 viewer) · container fill cool zinc-950(rgb 9 9 11) → 3중 다크(--elev/zinc-950/--sunken) 불일치 제거. */
        .detail-fullscreen .doc-fs-container { width: 100vw; max-width: 100vw; height: 100vh; height: 100dvh; background: rgb(9 9 11); border: none; border-radius: 0; box-shadow: none; display: flex; flex-direction: column; overflow: hidden; }
        /* bare body — .detail-body--bare(padding:0)에 full-height flex column 부여 → .doc-fs-split grid 가 panel 높이 채움 · 스크롤은 .doc-fs-body-wrap 셀이 소유(여기선 overflow:hidden, min-height:0 체인 유지). */
        .detail-fullscreen .doc-fs-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
        /* split grid: main(fluid) | meta(clamp 260-300). 가독성 본문 확폭 — meta col 소폭 축소(320→300)로 본문 여유 확보 + 모바일 collapse 분기. */
        .doc-fs-split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr clamp(260px, 20vw, 300px); overflow: hidden; }
        /* body wrap = 스크롤 컨테이너(구조 수정 핵심) — overflow:hidden → overflow-y:auto 전환 → 스크롤바가 body 셀 우측 끝(meta border 접점)에 안착("스크롤 우측 이동" 요청 충족) · grid 셀 높이 bound(상위 split flex:1+min-height:0) 가 scrollport 생성 → min-height:0 체인 유지 필수.
           bg cool zinc-950(rgb 9 9 11) 정합 + 좌우 padding clamp(32-72) gutter 보존. */
        .doc-fs-body-wrap { min-height: 0; padding: 24px clamp(32px, 4vw, 72px) 32px; background: rgb(9 9 11); overflow-y: auto; display: flex; flex-direction: column; scrollbar-width: thin; scrollbar-color: rgb(63 63 70 / 0.6) transparent; }
        /* 얇은 다크 스크롤바 — tokens.css 글로벌 *::-webkit-scrollbar(10px·--line warm)를 .doc-fs-* 스코프 한정 override(specificity 0,1,1 > 0,0,1). 8px·zinc thumb. */
        .doc-fs-body-wrap::-webkit-scrollbar { width: 8px; }
        .doc-fs-body-wrap::-webkit-scrollbar-track { background: transparent; }
        .doc-fs-body-wrap::-webkit-scrollbar-thumb { background: rgb(63 63 70 / 0.6); border-radius: 4px; border: none; }
        .doc-fs-body-wrap::-webkit-scrollbar-thumb:hover { background: rgb(82 82 91); }
        /* inner measure-aware — max-width min(90%,1280px)(화면 90% 비율 + 초광폭 ~95-105ch 캡) + margin-inline auto(중앙) → wrap 스크롤바는 외곽, 본문은 중앙. */
        .doc-fs-body-inner { width: 100%; max-width: min(90%, 1280px); margin-inline: auto; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        /* R6 — iframe 제거 후 .doc-body-isolation 컨테이너가 본문 직접 보유. */
        .doc-fs-body-inner > .doc-body-isolation { flex: 1 1 auto; min-height: 0; border-radius: 0; box-shadow: none; }
        /* 정당화된 단일 !important — 문서가 authored 한 max-w-4xl utility(56rem 고정)를 override → 넓어진 inner(min 90%/1280px) 를 본문이 채우도록. third-party 클래스 override = 문서화된 예외. */
        .doc-fs-body-inner > .doc-body-isolation { max-width: 100% !important; }
        /* 행간·자간 승리값 — > + 더블클래스 specificity(0,2,1) 로 문서 rescoped body 룰(0,1,0) 제압 → !important 불필요.
           line-height 1.75 · letter-spacing 0.012em(light-on-dark halation 보정) · 상속 base → 코드블록/헤딩 등 per-element 로컬 override 유지. */
        .doc-fs-body-inner > .doc-body-isolation { line-height: 1.75; letter-spacing: 0.012em; }
        /* meta sidebar — grid cell 풀높이 sticky · cool zinc(rgb 13 13 16 solid · 0.6 alpha 제거 → 본문 위 비침 제거) · border-left cool zinc(rgb 34 34 38 · --line warm 대체). */
        .doc-fs-meta-side { overflow-y: auto; border-left: 1px solid rgb(34 34 38); background: rgb(13 13 16); padding: 20px 24px; }
        /* 모바일 <768px — meta 하단 stack + border-top · wrap padding 축소 · bg 통일 반복(데스크톱 룰의 cool zinc 를 미디어 블록에서 재확인).
           max-width min(90%,1280px) 는 폰에서 90% 자동 승리(1280 캡 미발동) → px floor 없음 → overflow 무발생. 스크롤은 wrap 에서 동일 동작. */
        @media (max-width: 768px) {
          .doc-fs-split { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
          .doc-fs-body-wrap { padding: 16px 20px 20px; background: rgb(9 9 11); }
          .doc-fs-meta-side { border-left: none; border-top: 1px solid rgb(34 34 38); background: rgb(13 13 16); max-height: 40vh; padding: 16px 20px; }
        }
        /* T-DOC-5 뷰어 thin header — fullscreen viewer 의 CardHead 를 압축 (공용 .card-head 16×20 → 10×16).
           ui.jsx CardHead 미수정(scope discipline) · .doc-fs-container 스코프 한정 override.
           본문 가독 영역 확폭 + 헤더는 메타/액션 chrome 으로 물러남(design §1 중심 명료). */
        .doc-fs-container .card-head { padding: 10px 16px; }
        .doc-fs-container .card-head .card-title { font-size: 13px; }
        .doc-fs-container .card-head .card-sub { font-size: 12px; }
        /* WCAG 2.2 §2.5.8 Target Size (AA) — 24×24 px floor (본 화면 스코프 한정 · padding 보존). */
        .card button.btn.sm,
        .modal-head button.btn.sm,
        .doc-fs-container button.btn.sm { min-height: 24px; min-width: 24px; }
        button.doc-chip-badge { min-height: 24px; min-width: 24px; }
        /* (retired) .doc-status-badge — DocStatusBadgeCD 가 canonical Badge(role=status, interactive) 로 이전, screen-local FORM 제거. */
        /* multi-select + group UI tokens. */
        /* 선택 checkbox column — 항상 노출 (hover-only 시 사용자가 모름 → glass-atrium-design-designer reject). */
        .doc-checkbox-cell { width: 28px; padding: 4px 6px 4px 12px; text-align: center; vertical-align: middle; }
        .doc-checkbox-cell input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: rgb(var(--accent)); }
        /* 선택된 행 강조 — 기존 .is-selected (viewer focus) 와 색 구분: --accent 약한 채도. */
        .doc-row.is-multi-selected { background: rgb(var(--accent) / 0.10); }
        .doc-row.is-multi-selected.is-selected { background: rgb(var(--accent) / 0.16); }
        /* group action bar — filter chip 행 아래 sticky · zinc-900 코드블록 톤.
           height 고정 (44px min) 사유 — hint(텍스트 1줄) vs active(btn.sm 툴바) 두 모드의
           natural height 차이가 아래 목록을 (de)select 마다 점프시킴 → 상수 높이 + box-sizing
           border-box + 수직 center 정렬로 양 모드 픽셀 동일. flex-wrap 제거 (좁은 폭에서 2줄
           래핑이 다시 높이 변동 유발 → 단일행 유지 + 버튼이 reserved 높이 초과 차단). */
        .doc-group-action-bar { box-sizing: border-box; min-height: 44px; padding: 6px 16px; background: rgb(var(--sunken)); border-top: 1px solid rgb(var(--line)); display: flex; align-items: center; gap: 12px; }
        .doc-group-action-bar.is-hint { color: rgb(var(--faint)); font-size: var(--fs-meta); font-family: 'JetBrains Mono', monospace; }
        .doc-group-action-bar .selection-count { font-size: var(--fs-body); font-weight: 600; color: rgb(var(--ink)); font-family: 'JetBrains Mono', monospace; }
        /* 버튼이 reserved 44px 를 넘기지 않도록 상한 — 초과 시 bar 자체가 늘어나 점프 재발. */
        .doc-group-action-bar .btn.sm { max-height: 30px; }
        .doc-group-action-bar .ml-auto-actions { margin-left: auto; display: flex; gap: 8px; }
        /* group root row — chevron + member_count badge slot (folder icon 미사용). indent 시각 hint. */
        .doc-group-toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; background: transparent; border: none; padding: 2px 6px; color: rgb(var(--dim)); font-size: var(--fs-meta); border-radius: 4px; }
        .doc-group-toggle:hover { background: rgb(var(--line) / 0.5); color: rgb(var(--ink)); }
        .doc-group-toggle .chevron { transition: transform 160ms ease-out; }
        .doc-group-toggle.is-expanded .chevron { transform: rotate(90deg); }
        @media (prefers-reduced-motion: reduce) { .doc-group-toggle .chevron { transition: none; } }
        /* member rows — indent + 좌측 가는 가이드 선 (group 소속 시각 hint). */
        tr.doc-row.is-group-member td.title-cell { padding-left: 32px; position: relative; }
        tr.doc-row.is-group-member td.title-cell::before { content: ''; position: absolute; left: 14px; top: 0; bottom: 0; width: 1px; background: rgb(var(--line)); }
        /* group divider — root row 위쪽 subtle border (dark base 정합). */
        tr.doc-row.is-group-root { border-top: 1px solid rgb(var(--line) / 0.4); }
        /* DnD 재정렬 affordance.
           drag handle ⠿ — leading slot 내 grab cursor + subtle hover. handle 만 grab (행 전체 draggable 이나 시각 hint 는 handle 한정). */
        .doc-drag-handle { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 20px; font-size: 12px; line-height: 1; color: rgb(var(--faint)); cursor: grab; border-radius: 3px; user-select: none; }
        .doc-drag-handle:hover { color: rgb(var(--dim)); background: rgb(var(--line) / 0.5); }
        .doc-drag-handle:active { cursor: grabbing; }
        /* 끌고 있는 멤버 행 — dim + 점선 (drop target 시각 분리). dark base 정합. */
        tr.doc-row.is-group-member.is-dragging { opacity: 0.5; box-shadow: inset 0 0 0 1px rgb(var(--accent) / 0.5); }
        /* 재정렬 rollback inline 에러 — crit hue (toast 와 별개 · 영향 그룹 인접 표시). */
        .doc-reorder-error { color: rgb(var(--crit)); font-family: 'JetBrains Mono', monospace; }
      `}</style>

			<div className="flex-shrink-0">
				<PageHeader
					title="Documents"
					sub="Managed documents"
					right={headerRight}
				/>
			</div>

			{/* 단일 컬럼 — 검색 + facet + meta 가 DocListCardCD sticky 헤더에 통합. full-height = flex-1 + card-body maxHeight:'none' override. */}
			<div
				className="flex"
				style={{ minHeight: 0, flex: "1 1 auto", width: "100%" }}
			>
				<DocListCardCD
					state={listState}
					rows={visibleRows}
					isSearchMode={isSearchMode}
					selectedId={selectedId}
					pendingDelete={pendingDelete}
					hiddenCount={hiddenCount}
					total={total}
					docTotal={docTotal}
					visibleCount={visibleRows.length}
					canLoadMore={canLoadMore}
					loadMoreRemaining={loadMoreRemaining}
					isLoadingMore={isLoadingMore}
					onLoadMore={loadMore}
					selectedIds={selectedIds}
					onToggleSelection={toggleSelection}
					onSelectAll={(ids) => setSelectedIds(new Set(ids))}
					onClearSelection={() => setSelectedIds(new Set())}
					expandedFolderIds={expandedFolderIds}
					onToggleExpand={toggleExpand}
					onGroupCreate={performGroupCreate}
					onUngroup={performUngroup}
					onExportZip={exportSelectionAsZip}
					onStatusToggle={performStatusToggle}
					onReorder={performReorder}
					togglingIds={togglingIds}
					optimisticStatusOverrides={optimisticStatusOverrides}
					inlineFilterProps={{
						keyword,
						onKeywordChange: setKeyword,
						docStatusFilter,
						onDocStatusChange: setDocStatusFilter,
						audienceFilter,
						onAudienceChange: setAudienceFilter,
					}}
					onSelect={(id) => {
						setSelectedId(id);
						setIsFullscreen(true); // 행 클릭 = 전체화면 즉시 진입.
					}}
					onRetry={triggerRefresh}
				/>
			</div>

			{/* 전체화면 오버레이 — 유일한 뷰어 진입점. 종료 = backdrop 클릭 · Esc · 닫기 버튼 (모두 selectedId 비워 목록-only 복귀).
			    DetailSurface variant='fullscreen' bare 위임 — focus-trap/scroll-lock/Esc·backdrop 닫기/z·reduced-motion 계약은 공용 surface.
			    children 은 자체 chrome(CardHead/actions/superseded/meta) 소유 → bare · 불투명 zinc full-bleed 면은 panelClassName/bodyClassName 로 보존. */}
			{isFullscreen && selectedId != null && viewerState.status !== "idle" && (
				<DetailSurface
					open
					bare
					variant="fullscreen"
					panelClassName="doc-fs-container"
					bodyClassName="doc-fs-body"
					title={
						viewerState.status === "ready"
							? `${viewerState.data.title} full-screen viewer`
							: "Document viewer"
					}
					onClose={() => {
						setIsFullscreen(false);
						setSelectedId(null);
					}}>
					<ViewerPanelCD
						state={viewerState}
						pendingDelete={pendingDelete}
						onDelete={requestDelete}
						onClose={() => {
							setIsFullscreen(false);
							setSelectedId(null);
						}}
						onStatusToggle={performStatusToggle}
						togglingIds={togglingIds}
						optimisticStatusOverrides={optimisticStatusOverrides}
						onNavigate={setSelectedId}
						showToast={showToast}
					/>
				</DetailSurface>
			)}

			{/* 편집 모달 (작성 진입점 폐기 — agent emission 단일 경로). */}
			{editorOpen && (
				<EditorModalCD
					seed={editorOpen.seed}
					onClose={() => setEditorOpen(null)}
					onUpdate={performUpdate}
				/>
			)}

			{toast && (
				<div
					className={`doc-toast ${toast.tone}`}
					role="status"
					aria-live="polite"
				>
					{toast.message}
				</div>
			)}
		</div>
	);
}

// 중앙 목록 카드 — Sticky Header Integrated (검색 + facet + 건수 2-row).
// .card-body 인라인 maxHeight:'none' 으로 base.css `max-height: 70vh` override → 카드 viewport full-height + 카드 내부 스크롤.
function DocListCardCD({
	state,
	rows,
	isSearchMode,
	selectedId,
	pendingDelete,
	hiddenCount,
	total,
	docTotal,
	visibleCount,
	canLoadMore,
	loadMoreRemaining,
	isLoadingMore,
	onLoadMore,
	selectedIds,
	onToggleSelection,
	onSelectAll,
	onClearSelection,
	expandedFolderIds,
	onToggleExpand,
	onGroupCreate,
	onUngroup,
	onExportZip,
	onReorder,
	onStatusToggle,
	togglingIds,
	optimisticStatusOverrides,
	inlineFilterProps,
	onSelect,
	onRetry,
}) {
	const { Icon, Badge } = window.UI;
	// 건수 우측 표기 — groups mode 는 그룹/문서 이중 단위 + 서버 집계 숨김 건 (외부 headerRight 와 동일 규칙, F40) ·
	// search mode 는 row 단위 '건' + 숨은 건 있으면 "표시/전체" 이중 표기.
	const totalLabel =
		!isSearchMode && docTotal != null
			? `${formatIntCD(total)} groups · ${formatIntCD(docTotal)} documents${hiddenCount > 0 ? ` · ${formatIntCD(hiddenCount)} hidden` : ""}`
			: hiddenCount > 0
				? `${formatIntCD(visibleCount)} of ${formatIntCD(total)} shown`
				: `${formatIntCD(total)} matched`;

	// multi-select 파생값. server contract 정합 (group ≥ 2, ungroup ≥ 1).
	const selectionSize = selectedIds.size;
	const canGroup = selectionSize >= GROUP_MIN_MEMBERS_CD;
	const canUngroup = selectionSize >= 1;
	const allRowIds = rows.map((r) => r.id);
	// 모든 가시 행 선택 여부 — select-all 토글 상태 결정.
	const isAllSelected =
		rows.length > 0 && allRowIds.every((id) => selectedIds.has(id));
	const isPartialSelected =
		!isAllSelected && allRowIds.some((id) => selectedIds.has(id));

	return (
		<div
			className="card flex flex-col min-h-0"
			style={{ height: "100%", flex: "1 1 auto", width: "100%" }}
		>
			<div
				style={{
					position: "sticky",
					top: 0,
					zIndex: 2,
					background: "rgb(var(--elev))",
					borderBottom: "1px solid rgb(var(--line))",
				}}
			>
				{/* Row 1 — 검색 input (44px 터치 타겟 + Pretendard 가독). */}
				<div className="px-4 pt-3 pb-2">
					<div className="relative">
						<span className="doc-search-icon" aria-hidden="true">
							<Icon name="search" size={14} />
						</span>
						<input
							type="search"
							className="doc-search-input"
							placeholder="Search…"
							value={inlineFilterProps.keyword}
							onChange={(e) =>
								inlineFilterProps.onKeywordChange(e.target.value)
							}
							style={{ height: 44 }}
							aria-label="Search documents"
						/>
					</div>
				</div>
				{/* Row 2 — 대상 chips (좌측) + 건수 (우측 ml-auto). 마이크로 라벨 미사용 (chips 자체로 의미 전달). */}
				<div className="px-4 pb-2.5 flex items-center gap-2 flex-wrap">
					<div
						className="flex flex-wrap gap-1.5"
						role="radiogroup"
						aria-label="Audience filter"
					>
						{AUDIENCE_OPTIONS_CD.map((opt) => {
							const active = inlineFilterProps.audienceFilter === opt.value;
							return (
								<button
									key={opt.value}
									type="button"
									role="radio"
									className="doc-chip-badge"
									onClick={() => inlineFilterProps.onAudienceChange(opt.value)}
									aria-checked={active}
									aria-pressed={active}
									style={chipBadgeStyleCD("--info", active)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>
					<span
						className="ml-auto fs-meta font-mono"
						style={{ color: "rgb(var(--dim))" }}
					>
						{totalLabel}
					</span>
				</div>
				{/* Row 3 — doc_status chips — primary workflow filter (전체/진행중/완료).
            · /api/clauded-docs/groups endpoint ?doc_status= 송신 · search mode 미적용 (search 는 rows endpoint).
            · workflow lifecycle 1차 분류 (사용자 mental model: "지금 진행 중인 것들 보기"). */}
				<div className="px-4 pb-2.5 flex items-center gap-2 flex-wrap">
					<div
						className="flex flex-wrap gap-1.5"
						role="radiogroup"
						aria-label="Status filter"
					>
						{DOC_STATUS_OPTIONS_CD.map((opt) => {
							const active = inlineFilterProps.docStatusFilter === opt.value;
							const cssVar = DOC_STATUS_CSS_VAR_CD[opt.value] || "--faint";
							return (
								<button
									key={opt.value || "all"}
									type="button"
									role="radio"
									className="doc-chip-badge"
									onClick={() => inlineFilterProps.onDocStatusChange(opt.value)}
									aria-checked={active}
									aria-pressed={active}
									style={chipBadgeStyleCD(cssVar, active)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>
				</div>
				{/* pg_bigm 부재 disclosure (M6) — 서버는 startup warn 로그만 남겨 한글 부분일치
            저하(tsvector 단어 단위만 매칭)가 사용자에게 비가시 → 검색 모드에서 화면에 명시.
            === false 엄격 비교 — 필드 부재(groups 응답 · 구 서버) 시 미노출. */}
				{isSearchMode &&
					state.status === "ready" &&
					state.data?.bigmEnabled === false && (
						<div
							className="mx-4 mb-2.5 flex items-center gap-2 rounded-md px-3 py-2 fs-meta"
							style={{
								background: "rgb(var(--warn) / 0.1)",
								border: "1px solid rgb(var(--warn) / 0.28)",
								color: "rgb(var(--warn))",
							}}
							role="note"
						>
							<Icon name="warn" size={14} />
							<span style={{ color: "rgb(var(--dim))" }}>
								Search matches whole words only (Korean partial-word matching unavailable).
							</span>
						</div>
					)}
				{/* doc_type 필터/배지 서브시스템 전면 제거.
            · 사유: server monitor.documents 의 doc_type 컬럼 DROP → ?doc_type 필터 no-op · GET /:id 응답 키 부재 → 배지 항상 null.
              GOLDEN RULE — 모니터를 시스템(컬럼 부재)에 정합. doc_status(progress/done) 는 별개 live 축으로 유지. */}
				{/* GroupActionBar (multi-select bulk action).
            · selectionSize == 0 → hint bar ("문서 2건 이상 선택 후 그룹 만들기")
            · selectionSize ≥ 1 → 선택 N건 표시 + 그룹 해제 활성 + (≥2 시) 그룹 만들기 활성
            · search mode 에서도 노출 (사용자가 search 결과로 group 의도 가능 — 정합) */}
				<GroupActionBarCD
					selectionSize={selectionSize}
					canGroup={canGroup}
					canUngroup={canUngroup}
					onGroup={() => onGroupCreate(Array.from(selectedIds))}
					onUngroup={() => onUngroup(Array.from(selectedIds))}
					onExportZip={onExportZip}
					onClear={onClearSelection}
				/>
			</div>

			<div
				className="card-body flush"
				style={{
					maxHeight: "none",
					flex: "1 1 auto",
					minHeight: 0,
					overflowY: "auto",
				}}
			>
				{state.status === "loading" && <DocListSkeletonCD />}
				{state.status === "error" && (
					<ErrorBannerCD
						title="Couldn't load the list"
						detail={state.error}
						onRetry={onRetry}
					/>
				)}
				{state.status === "ready" && rows.length === 0 && (
					/* S6 정직한 빈 상태 — 적용 중 필터 echo + reset 제공 (blank 패널 금지). WCAG 4.1.3 announce. */
					<DocEmptyStateCD
						isSearchMode={isSearchMode}
						inlineFilterProps={inlineFilterProps}
					/>
				)}
				{state.status === "ready" && rows.length > 0 && (
					<table className="tbl">
						<thead>
							<tr>
								{/* designer-approved DocCheckboxCD (5-state · emerald-600 · WCAG 2.2 AA).
                    select-all 3-state cycle: unchecked → checked → indeterminate → checked (단방향 — UX 단순화). */}
								<th className="doc-checkbox-cell">
									<DocCheckboxCD
										checked={isAllSelected}
										indeterminate={isPartialSelected}
										onChange={() => {
											if (isAllSelected) onClearSelection();
											else onSelectAll(allRowIds);
										}}
										ariaLabel={isAllSelected ? "Clear selection" : "Select all"}
									/>
								</th>
								{/* doc_status badge 별도 column 분리 (title inline 제거 · 사용자 directive). */}
								{/* column 120px — 최장 라벨 "In progress" 배지 (mono 11px + padding) wrap 차단 + 여유. */}
								<th style={{ width: 120 }}>Status</th>
								<th>Title</th>
								<th style={{ width: 120 }}>Author</th>
								<th style={{ width: 100 }}>Created</th>
								{isSearchMode && (
									<th style={{ width: 56 }} className="num">
										Order
									</th>
								)}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const isSelectedViewer = row.id === selectedId;
								const isSelectedMulti = selectedIds.has(row.id);
								const isPending = pendingDelete && pendingDelete.id === row.id;
								const memberCount = Number(row.member_count);
								const isGroupRoot = memberCount > 1 && row.folder_id != null;
								const isExpanded =
									isGroupRoot && expandedFolderIds.has(row.folder_id);
								const rowClass = [
									"doc-row",
									isSelectedViewer && "is-selected",
									isSelectedMulti && "is-multi-selected",
									isPending && "is-pending-delete",
									isGroupRoot && "is-group-root",
								]
									.filter(Boolean)
									.join(" ");
								return (
									<React.Fragment key={row.id}>
										<tr
											className={rowClass}
											onClick={(e) => {
												// checkbox / action 버튼 클릭은 row click 으로 buble 시키지 않음.
												if (
													e.target.closest(
														'input[type="checkbox"], button, .doc-group-toggle',
													)
												)
													return;
												onSelect(row.id);
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													if (
														e.target.closest('input[type="checkbox"], button')
													)
														return;
													e.preventDefault();
													onSelect(row.id);
												}
											}}
											tabIndex={0}
											role="button"
											aria-label={`Open ${row.title}`}
											aria-current={isSelectedViewer ? "true" : undefined}
										>
											<td
												className="doc-checkbox-cell"
												onClick={(e) => e.stopPropagation()}
											>
												<DocCheckboxCD
													checked={isSelectedMulti}
													onChange={() => onToggleSelection(row.id)}
													ariaLabel={`Select ${row.title}`}
												/>
											</td>
											{/* doc_status badge 별도 column (title inline 제거). 빈 doc_status 는 — fallback (시각 정렬 보존).
                          onStatusToggle 주입 → 클릭 시 optimistic flip.
                          optimisticStatusOverrides Map 이 row.id entry 보유 시 그 값을 표시값으로 사용 (서버 refresh 도착 전 즉시 반영). */}
											<td>
												{row.doc_status ? (
													<DocStatusBadgeCD
														docStatus={
															optimisticStatusOverrides.get(row.id) ??
															row.doc_status
														}
														onToggle={() =>
															onStatusToggle(
																row.id,
																optimisticStatusOverrides.get(row.id) ??
																	row.doc_status,
																null,
															)
														}
														isToggling={togglingIds.has(row.id)}
													/>
												) : (
													<span
														className="fs-meta"
														style={{ color: "rgb(var(--faint))" }}
													>
														—
													</span>
												)}
											</td>
											<td className="title-cell">
												<div
													className="doc-title-row font-medium fs-title"
													style={{ color: "rgb(var(--ink))" }}
												>
													{/* 고정폭 leading slot — group-root 시 chevron, 그 외 빈칸 (제목 시작 x 통일). */}
													<span className="doc-title-lead">
														{isGroupRoot && (
															<button
																type="button"
																className={`doc-group-toggle ${isExpanded ? "is-expanded" : ""}`}
																onClick={(e) => {
																	e.stopPropagation();
																	onToggleExpand(row.folder_id);
																}}
																aria-expanded={isExpanded}
																aria-label={
																	isExpanded
																		? `Collapse group (${memberCount} documents)`
																		: `Expand group (${memberCount} documents)`
																}
																title={isExpanded ? "Collapse group" : "Expand group"}
															>
																<Icon name="chevron-right" className="chevron" size={10} />
															</button>
														)}
													</span>
													<span className="doc-title-main">
														{/* 제목 — line-clamp-2 + reserved 높이 (1↔2줄 행높이 점프 차단). full 은 title= 툴팁. */}
														<span className="doc-title-text" title={row.title}>
															{row.title}
														</span>
														{/* +N 멤버수 = 순수 수량 → count pill (neutral). leading slot 폭 가변 회피 위해 제목 뒤 trailing 배치. */}
														{/* data-doc-member-count → e2e 가 group-root 멤버수 배지를 다른 count pill 과 구분해 anchor 하는 안정 hook. */}
														{isGroupRoot && (
															<span data-doc-member-count>
																<Badge role="count">
																	+{memberCount - 1}
																</Badge>
															</span>
														)}
														{/* audience = 서술 속성(상태 아님) → neutral metadata pill, glyph/색 없음. */}
														{row.audience === "hidden" && (
															<span>
																<Badge role="metadata">agent-only</Badge>
															</span>
														)}
														{/* format = 서술 속성 → neutral metadata pill (md/yaml/json 철자, 색·square chip 폐기). */}
														{DOC_FORMAT_BADGE_CD[row.format] && (
															<span>
																<Badge role="metadata">
																	{row.format}
																</Badge>
															</span>
														)}
														{/* revision-chain = 관계 속성 → neutral metadata pill ('rev'), ↻ 장식 폐기 (F34). */}
														{row.supersedes_id != null && (
															<span
																title={`Replaces #${row.supersedes_id}`}
															>
																<Badge role="metadata">rev</Badge>
															</span>
														)}
													</span>
												</div>
												{isSearchMode && row.snippet && (
													<div
														className="doc-snippet doc-meta-text mt-1"
														style={{ color: "rgb(var(--dim))" }}
													>
														{parseSnippetCD(row.snippet)}
													</div>
												)}
											</td>
											<td
												className="doc-meta-text"
												style={{ color: "rgb(var(--dim))" }}
											>
												{row.author}
											</td>
											<td
												className="doc-meta-text-mono"
												style={{ color: "rgb(var(--dim))" }}
											>
												{formatDateCD(row.created_at)}
											</td>
											{isSearchMode && (
												<td
													className="num doc-meta-text-mono"
													style={{ color: "rgb(var(--faint))" }}
												>
													{row.rank != null ? (<span title={`Relevance ${Number(row.rank).toFixed(2)}`}>•</span>) : "—"}
												</td>
											)}
										</tr>
										{isExpanded && (
											<GroupMembersRowsCD
												folderId={row.folder_id}
												representativeId={row.id}
												memberCount={memberCount}
												onReorder={onReorder}
												isSearchMode={isSearchMode}
												selectedId={selectedId}
												selectedIds={selectedIds}
												pendingDelete={pendingDelete}
												onSelect={onSelect}
												onToggleSelection={onToggleSelection}
												onStatusToggle={onStatusToggle}
												togglingIds={togglingIds}
												optimisticStatusOverrides={optimisticStatusOverrides}
											/>
										)}
									</React.Fragment>
								);
							})}
						</tbody>
					</table>
				)}
				{/* Load More 버튼.
            · canLoadMore = !isSearchMode AND ready AND rows.length < total
            · isLoadingMore = offset>0 진행 중 — 버튼 label 'loading' 으로 전환 + disabled */}
				{state.status === "ready" && canLoadMore && (
					<div className="flex justify-center py-3 px-4">
						<button
							type="button"
							className="btn ghost sm"
							onClick={onLoadMore}
							disabled={isLoadingMore}
							aria-label={
								isLoadingMore
									? "Loading more"
									: `Show ${formatIntCD(loadMoreRemaining)} more`
							}
							style={{ minHeight: 32, minWidth: 120 }}
						>
							{isLoadingMore
								? "Loading…"
								: `Show ${formatIntCD(loadMoreRemaining)} more`}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

// GroupActionBar — 다중 선택 상태에 따라 hint bar / active bulk action 두 모드로 분기.
//   · selectionSize == 0 → 회색 hint ("문서 2건 이상 선택 후 그룹 만들기").
//   · selectionSize ≥ 1 → 선택 N건 표시 + 그룹 해제 활성.
//   · selectionSize ≥ 2 → 그룹 만들기 추가 활성.
// 비활성 버튼은 disabled + aria-disabled 명시 (silent fallback 금지).
function GroupActionBarCD({
	selectionSize,
	canGroup,
	canUngroup,
	onGroup,
	onUngroup,
	onExportZip,
	onClear,
}) {
	const { Icon } = window.UI;
	// 50건 초과 시 ZIP 다운로드 비활성 (서버 400 사전 차단)
	const canExportZip = selectionSize >= 1 && selectionSize <= 50;
	const exportZipTitle =
		selectionSize > 50
			? "Up to 50 documents per download"
			: `Download ${selectionSize} as zip`;

	if (selectionSize === 0) {
		return null;
	}
	return (
		<div
			className="doc-group-action-bar"
			role="toolbar"
			aria-label="Bulk group actions"
		>
			<span className="selection-count">{selectionSize} selected</span>
			<button
				type="button"
				className="btn ghost sm"
				onClick={onGroup}
				disabled={!canGroup}
				aria-disabled={!canGroup}
				title={
					canGroup
						? `Group ${selectionSize} documents together`
						: `Select at least ${GROUP_MIN_MEMBERS_CD}`
				}
			>
				Group
			</button>
			<button
				type="button"
				className="btn ghost sm"
				onClick={onUngroup}
				disabled={!canUngroup}
				aria-disabled={!canUngroup}
				title="Remove from group"
			>
				Ungroup
			</button>
			<button
				type="button"
				className="btn ghost sm"
				onClick={onExportZip}
				disabled={!canExportZip}
				aria-disabled={!canExportZip}
				title={exportZipTitle}
				aria-label="Download as zip"
			>
				<Icon name="download" size={13} />
				Download as zip
			</button>
			<div className="ml-auto-actions">
				<button
					type="button"
					className="btn ghost sm"
					onClick={onClear}
					aria-label="Clear selection"
				>
					Clear selection
				</button>
			</div>
		</div>
	);
}

// GroupMembersRowsCD — group 펼침 시 /api/clauded-docs?folder_id=X 로 같은 folder member row fetch + 표시.
//   · representative 포함 전체 멤버 표시 — rep 도 draggable 행 (index-0 pin 없음 · rep 이동 허용).
//   · AbortController — 펼침/접기 전환 race-safe.
//   · empty / error → 단일 행 안내 메시지 (silent 누락 금지).
function GroupMembersRowsCD({
	folderId,
	representativeId,
	memberCount,
	isSearchMode,
	selectedId,
	selectedIds,
	pendingDelete,
	onSelect,
	onToggleSelection,
	onReorder,
	onStatusToggle,
	togglingIds,
	optimisticStatusOverrides,
}) {
	const { Badge, Icon } = window.UI;
	const [memberState, setMemberState] = useStateCD({
		status: "loading",
		data: null,
		error: null,
	});
	// DnD 진행 중 끌고 있는 멤버 id (시각 강조용 · null = 비활성).
	const [draggingId, setDraggingId] = useStateCD(null);
	// DnD/keyboard 재정렬이 서버에 반영 안 됐을 때 표시할 inline 에러 (null = 정상).
	const [reorderError, setReorderError] = useStateCD(null);

	useEffectCD(() => {
		const ctrl = new AbortController();
		setMemberState({ status: "loading", data: null, error: null });
		// limit=200 — server max LIMIT 정합. 한 group 200건 초과는 production 0건.
		fetchJsonCD(
			`/api/clauded-docs?folder_id=${encodeURIComponent(folderId)}&include_archived=true&limit=200`,
			ctrl.signal,
		)
			.then((data) => {
				if (ctrl.signal.aborted) return;
				const rows = Array.isArray(data?.rows) ? data.rows : [];
				// representative 포함 전체 멤버 표시 — rep 도 draggable 행으로 노출.
				//   · 서버는 display_order ASC NULLS LAST, created_at ASC, id ASC 로 정렬해 응답 (rows 순서가 곧 표시 순서).
				//   · order-0 멤버 = 현재 representative → 펼친 목록 최상단에 자연 위치 · 재정렬로 다른 멤버를 0으로 올리면 rep 변경.
				setMemberState({ status: "ready", data: rows, error: null });
			})
			.catch((err) => {
				if (err && err.name === "AbortError") return;
				setMemberState({
					status: "error",
					data: null,
					error: err?.message || String(err),
				});
			});
		return () => ctrl.abort();
	}, [folderId, representativeId]);

	// 멤버 배열을 새 순서로 교체 후 서버 PATCH. 실패 시 이전 순서로 rollback.
	//   · fromIndex → toIndex 의 단일 이동 (DnD drop 진입점 — handleDrop 에서 호출).
	//   · orderedIds = nextMembers 전체 id 를 사용자 배치 순서 그대로 — rep 도 임의 위치.
	//     서버 set-equality (folder_id==rootId 전체) 충족 + order-0 멤버를 새 representative 로 선정.
	//   · 낙관적: 즉시 로컬 setMemberState 로 재배열 → PATCH 결과 false 면 prevMembers 복원.
	const moveMember = useCallbackCD(
		(fromIndex, toIndex) => {
			if (typeof onReorder !== "function") return;
			const current =
				memberState.status === "ready" ? memberState.data || [] : [];
			if (toIndex < 0 || toIndex >= current.length || fromIndex === toIndex)
				return;

			const prevMembers = current;
			const nextMembers = current.slice();
			const [moved] = nextMembers.splice(fromIndex, 1);
			nextMembers.splice(toIndex, 0, moved);

			// 낙관적 재배열 + inline 에러 초기화.
			setMemberState({ status: "ready", data: nextMembers, error: null });
			setReorderError(null);

			// 전체 visual 순서 그대로 송신 (rep-first pin 제거) — order-0 멤버가 새 representative.
			const orderedIds = nextMembers.map((m) => m.id);
			Promise.resolve(onReorder(folderId, orderedIds)).then((ok) => {
				if (!ok) {
					// rollback — 서버 반영 실패 시 이전 순서 복원 + inline 에러 표시.
					setMemberState({ status: "ready", data: prevMembers, error: null });
					setReorderError(
						"Order not saved — reverted to the previous order",
					);
				}
			});
		},
		[memberState, onReorder, folderId],
	);

	// DnD drop 핸들러. dragId(끌던 멤버) 를 targetId 앞/위치로 이동.
	const handleDrop = useCallbackCD(
		(targetId) => {
			const current =
				memberState.status === "ready" ? memberState.data || [] : [];
			const fromIndex = current.findIndex((m) => m.id === draggingId);
			const toIndex = current.findIndex((m) => m.id === targetId);
			if (fromIndex === -1 || toIndex === -1) return;
			moveMember(fromIndex, toIndex);
		},
		[memberState, draggingId, moveMember],
	);

	// column 구성: checkbox + status + title + author + created_at (+ rank if search) = 5 or 6.
	const colSpan = isSearchMode ? 6 : 5;
	// 재정렬 affordance 노출 조건: rep 포함 멤버 ≥ 2 (rep 도 행에 포함되므로 2건이면 순서 바꿔 rep 변경 가능)
	//   AND onReorder 주입됨 AND search mode 아님 (search 는 rank 정렬 — 재정렬 의미 없음).
	const members = memberState.status === "ready" ? memberState.data || [] : [];
	const isReorderable =
		typeof onReorder === "function" && !isSearchMode && members.length >= 2;

	if (memberState.status === "loading") {
		return (
			<tr className="doc-row is-group-member" aria-live="polite">
				<td className="doc-checkbox-cell" />
				<td
					colSpan={colSpan - 1}
					className="fs-meta"
					style={{ color: "rgb(var(--faint))", padding: "6px 12px" }}
				>
					Loading group members…
				</td>
			</tr>
		);
	}
	if (memberState.status === "error") {
		return (
			<tr className="doc-row is-group-member" role="alert">
				<td className="doc-checkbox-cell" />
				<td
					colSpan={colSpan - 1}
					className="fs-meta"
					style={{ color: "rgb(var(--crit))", padding: "6px 12px" }}
				>
					Couldn't load group members — {memberState.error}
				</td>
			</tr>
		);
	}
	if (members.length === 0) {
		return (
			<tr className="doc-row is-group-member">
				<td className="doc-checkbox-cell" />
				<td
					colSpan={colSpan - 1}
					className="fs-meta"
					style={{ color: "rgb(var(--faint))", padding: "6px 12px" }}
				>
					This group is empty
				</td>
			</tr>
		);
	}
	// Phase F — inline 재정렬 에러 행 (rollback 발생 시만 노출 · WCAG 4.1.3 role=alert announce).
	//   · React 는 array fragment 반환 시 각 원소 key 필요 → 에러 행 + 멤버 행 배열을 단일 array 로 concat.
	const errorRow = reorderError ? (
		<tr key="reorder-error" className="doc-row is-group-member" role="alert">
			<td className="doc-checkbox-cell" />
			<td
				colSpan={colSpan - 1}
				className="doc-reorder-error fs-meta"
				style={{ padding: "4px 12px" }}
			>
				{reorderError}
			</td>
		</tr>
	) : null;

	const memberRows = members.map((member) => {
		const isSelectedViewer = member.id === selectedId;
		const isSelectedMulti = selectedIds.has(member.id);
		const isPending = pendingDelete && pendingDelete.id === member.id;
		const isDragging = isReorderable && draggingId === member.id;
		const rowClass = [
			"doc-row",
			"is-group-member",
			isSelectedViewer && "is-selected",
			isSelectedMulti && "is-multi-selected",
			isPending && "is-pending-delete",
			isDragging && "is-dragging",
		]
			.filter(Boolean)
			.join(" ");
		return (
			<tr
				key={member.id}
				className={rowClass}
				// 행 전체를 draggable 로 (멤버 ≥ 2 + onReorder + non-search 시).
				//   · drag handle(⠿) 가 grab affordance 를 시각/aria 전달 · 행 자체 draggable 로 OS 드래그 이미지 자연스러움.
				draggable={isReorderable || undefined}
				onDragStart={
					isReorderable
						? (e) => {
								setDraggingId(member.id);
								// setData 필수 (Firefox 가 없으면 drag 시작 안 함) — id 문자열 전달.
								e.dataTransfer.effectAllowed = "move";
								try {
									e.dataTransfer.setData("text/plain", String(member.id));
								} catch (_e) {
									/* 일부 브라우저 setData 제한 — draggingId state 로 충분 */
								}
							}
						: undefined
				}
				onDragOver={
					isReorderable
						? (e) => {
								// preventDefault 해야 onDrop 이 발화 (HTML5 DnD 규약).
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
							}
						: undefined
				}
				onDrop={
					isReorderable
						? (e) => {
								e.preventDefault();
								handleDrop(member.id);
								setDraggingId(null);
							}
						: undefined
				}
				onDragEnd={isReorderable ? () => setDraggingId(null) : undefined}
				onClick={(e) => {
					if (
						e.target.closest('input[type="checkbox"], button, .doc-drag-handle')
					)
						return;
					onSelect(member.id);
				}}
				tabIndex={0}
				role="button"
				aria-label={`Open ${member.title} (group member)`}
			>
				<td className="doc-checkbox-cell" onClick={(e) => e.stopPropagation()}>
					<DocCheckboxCD
						checked={isSelectedMulti}
						onChange={() => onToggleSelection(member.id)}
						ariaLabel={`Select ${member.title}`}
					/>
				</td>
				{/* doc_status badge 별도 column (GroupMembersRows · 사용자 directive).
            onStatusToggle 주입 (list-row 와 동일 동작). */}
				<td>
					{member.doc_status ? (
						<DocStatusBadgeCD
							docStatus={
								optimisticStatusOverrides.get(member.id) ?? member.doc_status
							}
							onToggle={() =>
								onStatusToggle(
									member.id,
									optimisticStatusOverrides.get(member.id) ?? member.doc_status,
									null,
								)
							}
							isToggling={togglingIds.has(member.id)}
						/>
					) : (
						<span className="fs-meta" style={{ color: "rgb(var(--faint))" }}>
							—
						</span>
					)}
				</td>
				<td className="title-cell">
					<div
						className="doc-title-row font-medium fs-title"
						style={{ color: "rgb(var(--ink))" }}
					>
						{/* 멤버 행 leading slot — 재정렬 가능 시 drag handle(⠿), 아니면 빈칸 (제목 시작 x 통일). */}
						<span className="doc-title-lead">
							{isReorderable && (
								<span
									className="doc-drag-handle"
									aria-hidden="true"
									title="Drag to reorder"
									onClick={(e) => e.stopPropagation()}
								>
									<Icon name="grip-vertical" size={12} />
								</span>
							)}
						</span>
						<span className="doc-title-main">
							<span className="doc-title-text" title={member.title}>
								{member.title}
							</span>
							{member.audience === "hidden" && (
								<span>
									<Badge role="metadata">agent-only</Badge>
								</span>
							)}
							{/* format = 서술 속성 → neutral metadata pill (md/yaml/json 철자).
                · /api/clauded-docs?folder_id=X member row 가 format 보유 (list row 동일 shape). */}
							{DOC_FORMAT_BADGE_CD[member.format] && (
								<span>
									<Badge role="metadata">{member.format}</Badge>
								</span>
							)}
							{/* 멤버 재정렬 = 네이티브 drag-and-drop 단일 수단 (사용자 요청) — grab affordance 는 행 leading 의 ⠿ drag handle + 행 자체 draggable. */}
						</span>
					</div>
				</td>
				<td className="doc-meta-text" style={{ color: "rgb(var(--dim))" }}>
					{member.author}
				</td>
				<td className="doc-meta-text-mono" style={{ color: "rgb(var(--dim))" }}>
					{formatDateCD(member.created_at)}
				</td>
				{isSearchMode && (
					<td
						className="num doc-meta-text-mono"
						style={{ color: "rgb(var(--faint))" }}
					>
						—
					</td>
				)}
			</tr>
		);
	});

	// inline 에러 행을 멤버 행들 위에 prepend (rollback 안내가 영향받은 그룹 바로 위에 보이도록).
	return errorRow ? [errorRow, ...memberRows] : memberRows;
}

// 뷰어 패널 (전체화면 컨테이너 안에 마운트).
// 외부 .doc-fs-container 가 카드 시각언어 담당 → 내부 .card 중첩 회피.
// 본문 grid split: main(좌, fluid) + meta(우, sidebar). non-ready 상태는 main 만 표시.
function ViewerPanelCD({
	state,
	pendingDelete,
	onDelete,
	onClose,
	onStatusToggle,
	togglingIds,
	optimisticStatusOverrides,
	onNavigate,
	showToast,
}) {
	const { CardHead, Icon } = window.UI;
	const isReady = state.status === "ready";
	return (
		<div className="h-full flex flex-col min-h-0">
			<CardHead
				title={
					isReady
						? state.data.title
						: state.status === "idle"
							? "Document viewer"
							: "Loading…"
				}
				sub={null}
				right={
					isReady ? (
						<ViewerActionsCD
							doc={state.data}
							pendingDelete={pendingDelete}
							onDelete={onDelete}
							onClose={onClose}
							showToast={showToast}
						/>
					) : null
				}
			/>
			{/* superseded 배너 — successor 존재 = 구 revision 열람 중 (superseded 행은 server contract 상 done 고정, F34). */}
			{isReady && state.data.superseded_by_id != null && (
				<div className="doc-superseded-banner" role="status">
					<Icon name="warn" size={14} />
					<span>A newer version exists — you're viewing an old revision</span>
					<button
						type="button"
						className="btn sm"
						onClick={() => onNavigate?.(state.data.superseded_by_id)}
						aria-label={`View latest revision #${state.data.superseded_by_id}`}
					>
						View latest → #{state.data.superseded_by_id}
					</button>
				</div>
			)}
			{isReady ? (
				<div className="doc-fs-split">
					<ViewerBodyCD state={state} />
					<aside className="doc-fs-meta-side" aria-label="Document metadata">
						{/* doc(=viewer cache) 를 cachedRow 로 전달 → GET 스킵 (네트워크 절감). */}
						<DocMetaPanelCD
							doc={state.data}
							onStatusToggle={onStatusToggle}
							togglingIds={togglingIds}
							optimisticStatusOverrides={optimisticStatusOverrides}
							onNavigate={onNavigate}
						/>
					</aside>
				</div>
			) : (
				<ViewerBodyCD state={state} />
			)}
		</div>
	);
}

// Content-Disposition 헤더에서 filename 추출 — RFC 5987 filename*=UTF-8''… 우선, 평문 filename="…" 폴백.
//   · 헤더 부재/파싱 실패 → 호출부 폴백 filename 사용 (저장명 회귀 차단).
function parseContentDispositionFilenameCD(headerValue) {
	if (!headerValue) return null;
	const star = headerValue.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
	if (star) {
		try {
			return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
		} catch {
			// malformed percent-encoding → 평문 filename 폴백 시도.
		}
	}
	const plain = headerValue.match(/filename="?([^";]+)"?/i);
	return plain ? plain[1].trim() : null;
}

function ViewerActionsCD({ doc, pendingDelete, onDelete, onClose, showToast }) {
	const { Icon } = window.UI;
	const isPending = pendingDelete && pendingDelete.id === doc.id;
	const [isExporting, setIsExporting] = useStateCD(false);
	// 단일 문서 HTML 내려받기 — headless chromium 렌더 ~20s 소요 → fetch→blob 흐름으로 in-flight 피드백 확보.
	//   · 네이티브 <a download> 는 완료 시점을 JS 가 못 잡음 → exportSelectionAsZip 의 blob 패턴 mirror.
	//   · 저장명: Content-Disposition filename 보존 (헤더 부재 시 title/id 폴백) — 모든 포맷(HTML/YAML/JSON/TXT) 지원.
	//   · 처리 중 신호: 버튼 disabled + 'Generating…' 라벨이 1차 (~20s 전 구간 커버) · info toast 는 보조 (자동 소멸 가능).
	const handleHtmlExport = useCallbackCD(async () => {
		if (isExporting) return; // 중복 클릭 차단 — in-flight 중 재진입 무시.
		setIsExporting(true);
		showToast("info", "Generating HTML… this can take ~20s");
		try {
			const res = await fetch(`/api/clauded-docs/${doc.id}/html-export`);
			if (!res.ok) {
				const payload = await res.json().catch(() => null);
				const reason = describeApiErrorCD(payload, res.status);
				showToast("crit", `Download failed — ${reason}`);
				return;
			}
			const filename =
				parseContentDispositionFilenameCD(
					res.headers.get("content-disposition"),
				) || `${doc.title || doc.id}.html`;
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
			showToast("ok", `Downloaded ${filename}`);
		} catch (err) {
			showToast("crit", `Download failed — ${err?.message || err}`);
		} finally {
			setIsExporting(false);
		}
	}, [doc.id, doc.title, isExporting, showToast]);

	// 삭제 + HTML 내려받기 + 닫기. 닫기 = fullscreen 종료 (selectedId 해제) = 키보드 F 단축키 동일 동작.
	return (
		<div className="flex items-center gap-2 flex-wrap">
			<button
				type="button"
				className={`btn sm ${isPending ? "danger" : "ghost"}`}
				onClick={() => onDelete(doc.id)}
				aria-label={
					isPending ? "Confirm delete" : "Delete document"
				}
			>
				<Icon name="x" size={13} />
				{isPending ? "Confirm" : "Delete"}
			</button>
			<button
				type="button"
				className="btn ghost sm"
				onClick={handleHtmlExport}
				disabled={isExporting}
				aria-busy={isExporting ? "true" : undefined}
				aria-label={
					isExporting
						? "Generating HTML file…"
						: "Download as HTML"
				}
				style={{ cursor: isExporting ? "wait" : "pointer", opacity: isExporting ? 0.65 : 1 }}
			>
				<Icon name="download" size={13} />
				{isExporting ? "Generating HTML…" : "Download HTML"}
			</button>
			{onClose && (
				<button
					type="button"
					className="btn ghost sm"
					onClick={onClose}
					aria-label="Close viewer"
				>
					<Icon name="x" size={13} />
				</button>
			)}
		</div>
	);
}

// R6 본문 분리 컨테이너 className — htmlToReactCD 가 <style> 셀렉터를 이 클래스로 prefix scoping.
const DOC_BODY_SCOPE_CD = "doc-body-isolation";

// SYNC: src/server/clauded-docs/mermaid-normalize.ts 가 normalizeMermaidSource 의
// source of truth. 이 inline 사본은 client viewer 전용 (server .ts import 불가 —
// esbuild IIFE transpile, no module bundling) — 양쪽 (헬퍼 이름은 다르되) 로직 동일하게 유지.
// byte-identical 아님: client 사본의 private helper 는 shared .jsx namespace 충돌 회피용으로
// CD suffix 사용 (isMermaidTypeLineCD 등) → 단순 byte-diff drift 검사는 차이 나는 게 정상.
// keyword set + boundary class + acc/frontmatter/init/CRLF 재정렬 로직은 양쪽 동일 유지.
//
// mermaid v11 detectType 는 diagram-type keyword (flowchart 등) 를 FIRST significant
// line 으로 요구. acc directive (accTitle:/accDescr:) 가 type line 보다 위에 있으면
// "No diagram type detected" → 본 viewer 에서 raw <pre> fallback. 본 함수가 type line 을
// 첫 줄로 올리고 선행 acc directive 를 type line 바로 뒤로 이동시켜 정상 렌더 복원.
const MERMAID_TYPE_KEYWORDS_CD = [
	"flowchart",
	"graph",
	"sequenceDiagram",
	"classDiagram-v2",
	"classDiagram",
	"stateDiagram-v2",
	"stateDiagram",
	"erDiagram",
	"gantt",
	"pie",
	"journey",
	"gitGraph",
	"mindmap",
	"timeline",
	"quadrantChart",
	"requirementDiagram",
	"C4Context",
	"C4Container",
	"C4Component",
	"C4Dynamic",
	"C4Deployment",
	"block-beta",
	"packet-beta",
	"architecture-beta",
	"kanban",
	"xychart-beta",
	"sankey-beta",
	"zenuml",
];

function isMermaidTypeLineCD(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;
	const lower = trimmed.toLowerCase();
	for (const kw of MERMAID_TYPE_KEYWORDS_CD) {
		const kwLower = kw.toLowerCase();
		if (!lower.startsWith(kwLower)) continue;
		const after = trimmed.charAt(kw.length);
		if (after === "" || /[\s:;{(]/.test(after)) return true;
	}
	return false;
}

function isMermaidAccLineCD(line) {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("accTitle:") ||
		trimmed.startsWith("accDescr:") ||
		trimmed.startsWith("accDescr {") ||
		trimmed.startsWith("accDescr{")
	);
}

function holdMermaidFrontmatterCD(lines) {
	if (lines.length === 0 || lines[0].trim() !== "---") {
		return { held: [], next: 0 };
	}
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === "---") {
			return { held: lines.slice(0, i + 1), next: i + 1 };
		}
	}
	return { held: [], next: 0 };
}

function holdMermaidInitAndCommentsCD(lines, start) {
	const held = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim().startsWith("%%") || line.trim().length === 0) {
			held.push(line);
			i += 1;
			continue;
		}
		break;
	}
	while (held.length > 0 && held[held.length - 1].trim().length === 0) {
		held.pop();
		i -= 1;
	}
	return { held, next: i };
}

function collectMermaidAccUnitCD(lines, start) {
	const first = lines[start];
	const trimmed = first.trim();
	const isBraced =
		trimmed.startsWith("accDescr {") || trimmed.startsWith("accDescr{");
	if (!isBraced) {
		return { unit: [first], next: start + 1 };
	}
	const unit = [first];
	if (trimmed.includes("}")) {
		return { unit, next: start + 1 };
	}
	for (let i = start + 1; i < lines.length; i += 1) {
		unit.push(lines[i]);
		if (lines[i].includes("}")) {
			return { unit, next: i + 1 };
		}
	}
	return { unit, next: lines.length };
}

function normalizeMermaidSource(src) {
	if (src.length === 0) return src;
	const usesCrlf = src.includes("\r\n");
	const eol = usesCrlf ? "\r\n" : "\n";
	const lines = src.split(/\r\n|\n/);

	const frontmatter = holdMermaidFrontmatterCD(lines);
	const preamble = holdMermaidInitAndCommentsCD(lines, frontmatter.next);
	let cursor = preamble.next;

	const leadingAcc = [];
	const betweenLines = [];
	let typeLineIdx = -1;
	while (cursor < lines.length) {
		const line = lines[cursor];
		if (line.trim().length === 0) {
			betweenLines.push(line);
			cursor += 1;
			continue;
		}
		if (isMermaidAccLineCD(line)) {
			const acc = collectMermaidAccUnitCD(lines, cursor);
			leadingAcc.push(...acc.unit);
			cursor = acc.next;
			continue;
		}
		if (isMermaidTypeLineCD(line)) {
			typeLineIdx = cursor;
			break;
		}
		break;
	}

	if (leadingAcc.length === 0 || typeLineIdx === -1) {
		return src;
	}

	const typeLine = lines[typeLineIdx];
	const remaining = lines.slice(typeLineIdx + 1);
	const rebuilt = [
		...frontmatter.held,
		...preamble.held,
		typeLine,
		...leadingAcc,
		...betweenLines,
		...remaining,
	];
	return rebuilt.join(eol);
}

function ViewerBodyCD({ state }) {
	// Mermaid post-render hook — htmlToReactCD 가 React 트리를 호스트 DOM 에 commit 한 직후 <pre class="mermaid"> 텍스트를 SVG 로 변환.
	//   · 사유: htmlToReactCD 가 className 만 통과시킴 → <pre> 본문은 텍스트로 마운트 → JS 변환 필요
	//   · scope: bodyContainerRef.current 한정 (architecture.jsx 의 .arch-mermaid-canvas 와 충돌 차단)
	//   · in-place edit 안전: content_hash 변경 시 React 가 동일 <pre> DOM 재사용 → 새 textContent 로 effect 재실행
	//   · mermaid.run({nodes}) 우회: 내부 entityDecode 가 글로벌 escape() 의존 → 본 페이지 escape shim (babel-standalone 등) 가 &gt; 디코딩 실패 → --&gt; Lexical error · 우회 path = textContent (브라우저 native 디코드) 를 mermaid.render(id, src) 에 직접 전달 (architecture.jsx 패턴 mirror)
	//   · failure isolation: render promise reject → console.warn 만, viewer 전체 crash 차단
	//   · race-safety: doc 전환 중 in-flight Promise 가 stale 노드에 SVG 주입하는 것 차단 (cancelled flag · cleanup 함수)
	//   · deps: status + doc.id + content_hash — 문서 전환 + in-place edit 양쪽 재실행 보장
	const bodyContainerRef = useRefCD(null);
	useEffectCD(() => {
		if (state.status !== "ready") return;
		if (!window.mermaid || typeof window.mermaid.render !== "function") return;
		const container = bodyContainerRef.current;
		if (!container) return;
		const nodes = Array.from(
			container.querySelectorAll("pre.mermaid, .mermaid"),
		);
		if (nodes.length === 0) return;
		let cancelled = false;
		nodes.forEach((n, i) => {
			// detectType fix: acc directive 가 type line 보다 위에 있으면 정규화로 type line 을 첫 줄로 올림 (mermaid-normalize.ts SYNC).
			const source = normalizeMermaidSource(n.textContent);
			const id = `cd-mermaid-${state.data?.id || "x"}-${i}`;
			window.mermaid
				.render(id, source)
				.then(({ svg, bindFunctions }) => {
					if (cancelled) return;
					// SECURITY: mermaid 산출 SVG 는 trusted — 입력 source 는 server DOMPurify + client htmlToReactCD 이중 sanitize 통과한 본문 textContent (XSS surface 없음). architecture.jsx 의 mermaid.render 동일 신뢰 모델.
					n.innerHTML = svg;
					if (typeof bindFunctions === "function") bindFunctions(n);
				})
				.catch((err) => {
					if (cancelled) return;
					console.warn("[clauded-docs] mermaid.render failed:", err);
				});
		});
		return () => {
			cancelled = true;
		};
	}, [state.status, state.data?.id, state.data?.content_hash]);

	// highlight.js post-render hook — renderCodeFormatCD 가 React 트리를 commit 한 직후 yaml/json 코드 노드 syntax highlighting.
	//   · scope: bodyContainerRef.current 한정 (다른 화면 코드 블록 영향 차단)
	//   · in-place edit 안전: content_hash 변경 시 React 가 같은 <code> DOM 재사용 — data-highlighted 강제 해제 후 재실행 (mermaid 패턴과 동일)
	//   · txt 는 language class 없어 hljs.highlightElement auto-detect skip — noop (안전)
	//   · failure isolation: hljs.highlightElement throw → console.warn 만, viewer 전체 crash 차단
	//   · deps: status + doc.id + content_hash + format — 문서 전환 + 인플레이스 edit + format 전환 양쪽 재실행 보장
	useEffectCD(() => {
		if (state.status !== "ready") return;
		if (!window.hljs || typeof window.hljs.highlightElement !== "function")
			return;
		const container = bodyContainerRef.current;
		if (!container) return;
		const nodes = Array.from(container.querySelectorAll("code[data-format]"));
		if (nodes.length === 0) return;
		nodes.forEach((n) => {
			n.removeAttribute("data-highlighted");
			try {
				window.hljs.highlightElement(n);
			} catch (err) {
				console.warn("[clauded-docs] hljs.highlightElement failed:", err);
			}
		});
	}, [
		state.status,
		state.data?.id,
		state.data?.content_hash,
		state.data?.format,
	]);

	if (state.status === "idle") {
		return <div className="doc-empty m-4">Select a document from the list</div>;
	}
	if (state.status === "loading") {
		return (
			<div className="p-4" aria-busy="true">
				<div style={skeletonBlockStyleCD(40)} />
				<div style={{ ...skeletonBlockStyleCD(220), marginTop: 12 }} />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<ErrorBannerCD title="Couldn't load the document body" detail={state.error} />
		);
	}

	// 본문 렌더 — 분기 (MD primary + 4-format code viewer):
	//   · Code format (agent-only — format ∈ {yaml, json, txt}) → renderCodeFormatCD (<pre><code> + 후속 hljs hook)
	//   · HTML primary (보고/계획/구조 — html_path .html) → htmlToReactCD 직접 진입
	//   · MD primary (format=md 또는 html_path .md) → renderMarkdownCD (frontmatter strip + marked.parse + htmlToReactCD chain)
	//   · MD / HTML primary 양쪽 DOMPurify + DOMParser + React 트리 통과 (defense-in-depth 일관)
	//   · code format 은 React text child 로 본문 전달 — sanitize 경로 불요 (raw HTML 인젝션 surface 0)
	//   · throw / null 시 ErrorBanner fail-safe — silent fallback 금지
	const doc = state.data;
	const isCodeFormat = isCodeFormatDocCD(doc);
	const isMdPrimary = !isCodeFormat && isMdPrimaryDocCD(doc);
	let rendered = null;
	let renderError = null;
	try {
		if (isCodeFormat) {
			rendered = renderCodeFormatCD(doc.body, doc.format, DOC_BODY_SCOPE_CD);
		} else if (isMdPrimary) {
			rendered = renderMarkdownCD(doc.body, DOC_BODY_SCOPE_CD);
		} else {
			rendered = htmlToReactCD(doc.body, DOC_BODY_SCOPE_CD);
		}
	} catch (err) {
		renderError = err && err.message ? err.message : String(err);
	}
	if (renderError || rendered == null) {
		return (
			<ErrorBannerCD
				title="Couldn't render the document body"
				detail={
					renderError ||
					"DOMPurify or DOMParser unavailable — refresh the page and try again"
				}
			/>
		);
	}

	// body 태그의 className/style 을 컨테이너로 lift → bg-zinc-950 같은 utility 가 컨테이너에 직접 적용.
	const bodyClass = rendered.className
		? `${DOC_BODY_SCOPE_CD} ${rendered.className}`
		: DOC_BODY_SCOPE_CD;
	return (
		<div className="doc-fs-body-wrap">
			<div className="doc-fs-body-inner">
				<div
					ref={bodyContainerRef}
					className={bodyClass}
					style={rendered.style || undefined}
					aria-label={`${doc.title} — document body`}
				>
					{rendered.children}
				</div>
			</div>
		</div>
	);
}

function DocMetaPanelCD({
	doc,
	onStatusToggle,
	togglingIds,
	optimisticStatusOverrides,
	onNavigate,
}) {
	const { Badge } = window.UI;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 mb-2 flex-wrap">
				{/* doc_status dual-encoded badge (workflow lifecycle 진행중/완료).
            onStatusToggle 옵셔널 주입 (legacy 호출 호환 — toggle 없으면 read-only span).
            cachedRow=doc — viewer state 가 body + content_hash + format 보유 → GET 스킵 (네트워크 절감). */}
				<DocStatusBadgeCD
					docStatus={optimisticStatusOverrides?.get(doc.id) ?? doc.doc_status}
					onToggle={
						typeof onStatusToggle === "function"
							? () =>
									onStatusToggle(
										doc.id,
										optimisticStatusOverrides?.get(doc.id) ?? doc.doc_status,
										doc,
									)
							: undefined
					}
					isToggling={togglingIds?.has(doc.id) ?? false}
				/>
				<span
					className="fs-meta font-mono"
					style={{ color: "rgb(var(--dim))" }}
				>
					#{doc.id}
				</span>
				{/* format = 서술 속성 → neutral metadata pill (md/yaml/json/txt 철자, 색·square glyph 폐기).
            · doc.format 바인딩 · 미지정 format 은 배지 미출력 (거짓 주장 방지). */}
				{DOC_FORMAT_BADGE_CD[doc.format] && (
					<span>
						<Badge role="metadata">{doc.format}</Badge>
					</span>
				)}
			</div>
			<div className="doc-meta-row">
				<span className="doc-meta-label">Author</span>
				<span className="doc-meta-value">{doc.author}</span>
			</div>
			<div className="doc-meta-row">
				<span className="doc-meta-label">Created</span>
				<span className="doc-meta-value font-mono">
					{formatDateTimeCD(doc.created_at)}
				</span>
			</div>
			{/* supersedes chain predecessor.
          · supersedes_id != null 시 predecessor 단일 fetch + meta drawer 섹션 surface
          · successor 는 ViewerPanelCD 상단 배너 (superseded_by_id) 가 담당 — 양방향 1-hop 네비게이션 (F34) */}
			{doc.supersedes_id != null && (
				<PredecessorPanelCD
					predecessorId={doc.supersedes_id}
					currentDoc={doc}
					onNavigate={onNavigate}
				/>
			)}
		</div>
	);
}

// doc_status dual-encoded badge (workflow lifecycle).
//   · 색상: DOC_STATUS_CSS_VAR_CD 매핑 — progress=--warn / done=--ok (canonical 2-state).
//   · text label: In progress / Done.
//   · 위치: 목록 row 의 title 아래 + meta panel (DocMetaPanelCD).
// doc_status badge 시맨틱 업그레이드.
//   · onToggle 미제공 → 기존 <span> read-only fallback (backwards-compat — 호출 사이트 점진 마이그레이션 안전).
//   · onToggle 제공 → 시맨틱 <button> + aria-label 동작 명시 + aria-busy in-flight 표시.
//     · 키보드 활성화 (Enter / Space) 는 native button 이 자동 처리 — 별도 핸들러 불필요.
//     · dual-encoding — TONE_ICON Lucide(check/warn) + 텍스트 라벨 (In progress/Done) 2중 채널 (Badge status SoT).
//     · pending 상태 → 라벨 'Changing…' + 투명도 0.65 (색상 회전 회피 — 새 의미 카테고리 시사 차단).
//     · prefers-reduced-motion 자동 정합 — transition 미사용 (instant swap).
function DocStatusBadgeCD({ docStatus, onToggle, isToggling }) {
	const { Badge } = window.UI;
	if (!docStatus) return null;
	// lifecycle 상태 = status role: progress→warn(in-flight) / done→ok(완료).
	const tone =
		docStatus === "progress" ? "warn" : docStatus === "done" ? "ok" : "info";
	const label =
		docStatus === "progress"
			? "In progress"
			: docStatus === "done"
				? "Done"
				: docStatus;

	// Read-only fallback — 호출 사이트가 onToggle 을 넘기지 않은 경우 (점진 마이그레이션 안전망).
	if (typeof onToggle !== "function") {
		return (
			<span title={`Status — ${label}`}>
				<Badge role="status" tone={tone} icon>
					{label}
				</Badge>
			</span>
		);
	}

	// Interactive — 캐노니컬 window.UI.Badge(role=status)를 interactive 로 렌더 → read-only <Badge role=status> 와 동일 FORM.
	//   · Badge 가 <button className="pill pill--interactive"> + 선행 tone glyph(status role)을 생성 — screen-local .doc-status-badge 폐기.
	//   · dedup: pending(isToggling) 중 onClick 을 no-op 가드 (disabled attr 없이 중복 PUT 차단).
	//   · pending 상태는 라벨 'Changing…'(button 접근 이름) + title 이 운반 → 상태/동작 접근성 유지.
	//   · focus-visible ring 은 .pill--interactive(base.css) 이 담당 (인라인 tailwind ring 유틸 제거).
	const oppositeLabel = docStatus === "progress" ? "Done" : "In progress";
	const displayLabel = isToggling ? "Changing…" : label;

	return (
		<Badge
			role="status"
			tone={tone}
			icon
			interactive
			title={isToggling ? "Changing status…" : `Click to mark ${oppositeLabel}`}
			onClick={(e) => {
				// row click bubble 차단 — DocListCardCD onClick 이 viewer fullscreen 진입 트리거 (의도 충돌).
				e.stopPropagation();
				if (!isToggling) onToggle();   // pending 중 중복 PUT 차단 (disabled attr 대체 가드)
			}}
		>
			{displayLabel}
		</Badge>
	);
}

// DocCheckboxCD — 5-state spec — 16px square · 2px border · 4px radius · WCAG 2.2 AA focus-visible
//   · default     — bg-zinc-900 border-zinc-600
//   · hover       — bg-zinc-800 border-zinc-400
//   · focus-visible — +ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-950
//   · checked     — bg-emerald-600 border-emerald-600 + white check SVG
//   · indeterminate — bg-emerald-600 border-emerald-600 + white minus SVG
//
// Implementation 결정 (glass-atrium-design-designer 자문 4-Axis 16/20 정합):
//   · native <input type=checkbox> 보존 — screen reader / keyboard / form submit 호환
//   · appearance-none 으로 OS default 제거 → 시각 영역만 재구성
//   · indeterminate 는 HTML attribute 아닌 JS property — React ref + useEffect 로 양방향 동기화
//   · check/minus SVG inline overlay (절대 위치 + peer state 의존하지 않음 — React conditional render)
//     ※ peer-checked 미사용 사유 — native checkbox 자체에 ::after / pseudo-element 불가 (browser 제한)
//     → wrapper span 으로 SVG overlay 배치, checked/indeterminate 분기 React 측에서 처리
//   · transition-colors duration-150 — glass-atrium-design-designer 자문 motion: spatial-fast equivalent (CSS-only)
function DocCheckboxCD({
	checked,
	indeterminate,
	onChange,
	ariaLabel,
	onClick,
}) {
	const { Icon } = window.UI;
	const inputRef = useRefCD(null);

	// indeterminate 는 HTML attribute 가 아닌 DOM property — ref + useEffect 로 React state 동기화.
	useEffectCD(() => {
		if (inputRef.current) {
			inputRef.current.indeterminate = !!indeterminate;
		}
	}, [indeterminate]);

	return (
		<span
			className="relative inline-flex items-center justify-center"
			style={{ width: 16, height: 16, cursor: "pointer" }}
		>
			<input
				ref={inputRef}
				type="checkbox"
				checked={!!checked}
				onChange={onChange}
				onClick={onClick}
				aria-label={ariaLabel}
				className="appearance-none w-4 h-4 rounded border-2 border-zinc-600 bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-400 checked:bg-emerald-600 checked:border-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 transition-colors duration-150 cursor-pointer"
				style={{ margin: 0 }}
			/>
			{/* check SVG — checked 단독 시 표시 (indeterminate 우선) */}
			{checked && !indeterminate && (
				<Icon name="check" size={12} stroke={3} className="pointer-events-none absolute text-white" />
			)}
			{/* minus SVG — indeterminate 시 표시 (체크박스 자체는 checked attribute 무시) */}
			{indeterminate && (
				<Icon name="minus" size={12} stroke={3} className="pointer-events-none absolute text-white" />
			)}
		</span>
	);
}

// version-history (supersede chain) 섹션 — collapsible <details> default-collapsed (T-DOC-3).
//   · 현재 revision 강조(--ink) + predecessor 는 .acked(opacity 0.5) 로 dim → 어느 쪽이 latest 인지 시각 구분.
//   · predecessor fetch + 1-hop 네비게이션 (F34) — GET /api/clauded-docs/:id 재사용 (server route 미변경).
//   · AbortController 로 predecessor 전환 race-safe · fetch 실패(404 등) → 경고 표시(silent fallback 금지).
//   · onNavigate(setSelectedId) = predecessor 열기 — successor 방향은 ViewerPanelCD 상단 배너 담당.
function PredecessorPanelCD({ predecessorId, currentDoc, onNavigate }) {
	const [predState, setPredState] = useStateCD({
		status: "loading",
		data: null,
		error: null,
	});

	useEffectCD(() => {
		const ctrl = new AbortController();
		setPredState({ status: "loading", data: null, error: null });
		fetchJsonCD(
			`/api/clauded-docs/${encodeURIComponent(predecessorId)}`,
			ctrl.signal,
		)
			.then((data) => {
				if (ctrl.signal.aborted) return;
				setPredState({ status: "ready", data, error: null });
			})
			.catch((err) => {
				if (err && err.name === "AbortError") return;
				setPredState({
					status: "error",
					data: null,
					error: err?.message || String(err),
				});
			});
		return () => ctrl.abort();
	}, [predecessorId]);

	return (
		<details
			className="doc-version-history mt-3 pt-3"
			style={{ borderTop: "1px solid rgb(var(--line))" }}
		>
			<summary
				className="fs-micro font-mono uppercase tracking-wider"
				style={{ color: "rgb(var(--faint))", cursor: "pointer" }}
			>
				Version history
			</summary>
			<div className="mt-2 flex flex-col gap-2">
				{/* 현재 revision — 강조(--ink) · acked 미적용. */}
				<div className="doc-revision-current">
					<span
						className="fs-micro font-mono uppercase tracking-wider"
						style={{ color: "rgb(var(--ok))" }}
					>
						Current revision
					</span>
				</div>
				{/* predecessor — .acked (opacity 0.5) dim. */}
				{predState.status === "loading" && (
					<div style={skeletonBlockStyleCD(40)} />
				)}
				{predState.status === "error" && (
					<div
						className="fs-meta"
						style={{ color: "rgb(var(--warn))" }}
						role="alert"
					>
						Couldn't load previous revision #{predecessorId} —{" "}
						{predState.error}
					</div>
				)}
				{predState.status === "ready" && predState.data && (
					<div className="doc-revision-predecessor acked flex flex-col gap-1">
						<div className="flex items-center gap-2 flex-wrap">
							<span
								className="text-[11px] font-mono"
								style={{ color: "rgb(var(--dim))" }}
							>
								#{predState.data.id}
							</span>
							<span
								className="fs-micro font-mono uppercase tracking-wider"
								style={{ color: "rgb(var(--faint))" }}
							>
								Previous
							</span>
							{typeof onNavigate === "function" && (
								<button
									type="button"
									className="btn ghost sm"
									onClick={() => onNavigate(predecessorId)}
									aria-label={`View previous revision #${predecessorId}`}
								>
									View previous →
								</button>
							)}
						</div>
						<div
							className="text-[12px] mt-1"
							style={{ color: "rgb(var(--ink))", wordBreak: "break-all" }}
						>
							{predState.data.title}
						</div>
						<div
							className="text-[10.5px] font-mono"
							style={{ color: "rgb(var(--faint))" }}
						>
							{formatDateTimeCD(predState.data.created_at)} ·{" "}
							{predState.data.author}
						</div>
					</div>
				)}
			</div>
		</details>
	);
}

// 편집 전용 모달 (작성 진입점은 폐기 — agent emission POST 단일 경로).
//   - 작성자 = seed 고정 (편집 중 변경 불가 — server 측 immutable 필드 정합).
//   - 본문 + content_hash 는 서버에서 강제 재조회 (목록 응답에는 본문 미포함).
function EditorModalCD({ seed, onClose, onUpdate }) {
	const { Icon } = window.UI;
	// 편집 가능 필드 — title · htmlBody (server 측 mutable). doc_type 컬럼 DROP → 편집 필드 제거.
	const [title, setTitle] = useStateCD(seed?.title || "");
	const [htmlBody, setHtmlBody] = useStateCD("");
	// 표시 전용 (immutable) — seed 에서 한 번 캡처 → render 만, 변경 없음.
	const author = seed?.author || "user";
	const [busy, setBusy] = useStateCD(false);
	const [seedFetchState, setSeedFetchState] = useStateCD({ status: "loading" });

	// 본문 + content_hash 를 동기화 위해 서버에서 한 번 더 가져옴 (목록 응답에는 본문이 없음).
	//   · format query 생략 → 서버 default resolution (rowFormat 자동 감지).
	useEffectCD(() => {
		if (!seed?.id) return;
		const ctrl = new AbortController();
		fetchJsonCD(`/api/clauded-docs/${encodeURIComponent(seed.id)}`, ctrl.signal)
			.then((data) => {
				setHtmlBody(data.body);
				setSeedFetchState({ status: "ready", expectedHash: data.content_hash });
			})
			.catch((err) =>
				setSeedFetchState({
					status: "error",
					error: err?.message || String(err),
				}),
			);
		return () => ctrl.abort();
	}, [seed?.id]);

	// ESC 닫기.
	useEffectCD(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const canSubmit =
		title.trim() !== "" &&
		htmlBody.trim() !== "" &&
		author.trim() !== "" &&
		!busy &&
		seedFetchState.status === "ready";

	const handleSubmit = useCallbackCD(
		async (e) => {
			e.preventDefault();
			if (!canSubmit) return;
			setBusy(true);
			const ok = await onUpdate(seed.id, {
				html_body: htmlBody,
				expected_hash: seedFetchState.expectedHash,
				title: title.trim(),
			});
			if (!ok) setBusy(false);
		},
		[canSubmit, seed?.id, title, htmlBody, seedFetchState, onUpdate],
	);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<form
				className="modal"
				onClick={(e) => e.stopPropagation()}
				onSubmit={handleSubmit}
				style={{
					width: "min(820px, 96vw)",
					maxWidth: "min(820px, 96vw)",
					maxHeight: "92vh",
				}}
			>
				<div className="modal-head">
					<div className="font-semibold text-[14px]">
						{`Edit #${seed?.id ?? ""}`}
					</div>
					<button
						type="button"
						className="btn ghost sm"
						onClick={onClose}
						aria-label="Close"
					>
						<Icon name="x" size={14} />
					</button>
				</div>
				<div className="modal-body" style={{ padding: 18 }}>
					{seedFetchState.status === "loading" && (
						<div className="doc-empty mb-3">Loading current body…</div>
					)}
					{seedFetchState.status === "error" && (
						<ErrorBannerCD
							title="Couldn't load the current body"
							detail={seedFetchState.error}
						/>
					)}
					<div
						className="grid gap-3"
						style={{ gridTemplateColumns: "1fr 140px" }}
					>
						<label className="flex flex-col gap-1">
							<span
								className="text-[10.5px] font-mono uppercase tracking-wider"
								style={{ color: "rgb(var(--faint))" }}
							>
								Title
							</span>
							<input
								type="text"
								className="doc-editor-input"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								required
								maxLength={500}
								aria-label="Document title"
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span
								className="text-[10.5px] font-mono uppercase tracking-wider"
								style={{ color: "rgb(var(--faint))" }}
							>
								Author
							</span>
							{/* 편집 모드 — 작성자 immutable (감사 추적 보존). */}
							<input
								type="text"
								className="doc-editor-input"
								value={author}
								disabled
								required
								maxLength={64}
								aria-label="Author"
							/>
						</label>
					</div>
					<label className="flex flex-col gap-1 mt-3">
						<span
							className="text-[10.5px] font-mono uppercase tracking-wider"
							style={{ color: "rgb(var(--faint))" }}
						>
							HTML body
						</span>
						<textarea
							className="doc-editor-textarea"
							value={htmlBody}
							onChange={(e) => setHtmlBody(e.target.value)}
							required
							spellCheck={false}
							aria-label="HTML body"
						/>
					</label>
				</div>
				<div className="modal-foot">
					<button
						type="button"
						className="btn ghost sm"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="btn primary sm"
						disabled={!canSubmit}
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</form>
		</div>
	);
}

function ErrorBannerCD({ title, detail, onRetry }) {
	const { Icon } = window.UI;
	return (
		<div
			className="m-4 p-3 rounded-md border"
			style={{
				borderColor: "rgb(var(--crit) / 0.4)",
				background: "rgb(var(--crit) / 0.1)",
				color: "rgb(var(--crit))",
				fontSize: 12,
			}}
			role="alert"
		>
			<div className="flex items-center gap-2 mb-1">
				<Icon name="warn" size={14} />
				<span className="font-semibold">{title}</span>
			</div>
			{detail && (
				<div
					className="font-mono text-[11px]"
					style={{ color: "rgb(var(--dim))" }}
				>
					{detail}
				</div>
			)}
			{onRetry && (
				<button type="button" className="btn ghost sm mt-2" onClick={onRetry}>
					<Icon name="refresh" size={12} />
					Retry
				</button>
			)}
		</div>
	);
}

function DocListSkeletonCD() {
	return (
		<div className="p-4" aria-busy="true" aria-label="Loading documents">
			{Array.from({ length: 6 }).map((_, i) => (
				<div key={i} style={{ ...skeletonBlockStyleCD(36), marginBottom: 8 }} />
			))}
		</div>
	);
}

// S6 정직한 빈 상태 — 적용 중인 필터(검색어/상태/대상)를 명시 echo + 한 번에 초기화.
//   · docStatus default 'progress' / audience default 'all' 기준으로 non-default 만 active 집계.
//   · active 0건(빈 목록 자체) → reset 버튼 미노출 ("초기화할 필터 없음" 정직성).
function DocEmptyStateCD({ isSearchMode, inlineFilterProps }) {
	const { keyword, docStatusFilter, audienceFilter } = inlineFilterProps;
	const statusLabel = (
		DOC_STATUS_OPTIONS_CD.find((o) => o.value === docStatusFilter) || {}
	).label;
	const audienceLabel = (
		AUDIENCE_OPTIONS_CD.find((o) => o.value === audienceFilter) || {}
	).label;
	const activeFilters = [];
	if (keyword && keyword.trim()) activeFilters.push(`“${keyword.trim()}”`);
	if (docStatusFilter) activeFilters.push(`status: ${statusLabel}`);
	if (audienceFilter !== "all") activeFilters.push(`audience: ${audienceLabel}`);
	const hasActiveFilters = activeFilters.length > 0;

	const resetFilters = () => {
		inlineFilterProps.onKeywordChange("");
		inlineFilterProps.onDocStatusChange("");
		inlineFilterProps.onAudienceChange("all");
	};

	return (
		<div className="doc-empty m-4" role="status" aria-live="polite">
			<div>{isSearchMode ? "No matches" : "No documents"}</div>
			{hasActiveFilters && (
				<div
					className="fs-meta mt-2"
					style={{ color: "rgb(var(--faint))" }}
				>
					Filters: {activeFilters.join(" · ")}
				</div>
			)}
			{hasActiveFilters && (
				<button
					type="button"
					className="btn ghost sm mt-3"
					onClick={resetFilters}
					style={{ minHeight: 32 }}
					aria-label="Clear all filters"
				>
					Clear filters
				</button>
			)}
		</div>
	);
}

// audience 필터 — 서버 audience 2값 {exposed, hidden}.
//   · audience 미정(null) row 는 explicit 'exposed' default (silent 추론 금지 · legacy normalize 결과 정합).
//   · legacy ops/public/agent-only 는 server read-side 에서 exposed/hidden 으로 normalize 되어 도착.
function buildVisibleRowsCD(rows, audienceFilter) {
	if (!Array.isArray(rows)) return [];
	if (audienceFilter === "all") return rows;
	return rows.filter((row) => {
		const audience = row?.audience ?? "exposed";
		if (audienceFilter === "agent-only") return audience === "hidden";
		return audience === "exposed";
	});
}

// q 가 있으면 search endpoint, 없으면 groups endpoint (folder grouping default).
//   · offset 인자 추가 (Load More 페이지네이션 기반).
//   · search endpoint 는 offset 미지원 (current scope) — q 분기 시 offset 무시.
//   · list mode default 가 /api/clauded-docs/groups 로 전환.
//     · groups endpoint = folder grouping list (group/page · 단일 + 다건 통합) · doc_status filter 지원
//     · rows endpoint (/api/clauded-docs) 는 search mode 만 (FTS 결과 — group 개념 없음)
//     · groups response shape {total, groups, ...} → 호출처가 normalizeGroupToRowCD 로 row-like 정규화
//     · docStatus 신규 param — '' 빈 값 시 미송신 (전체)
function buildListUrlCD({ q, docStatus, offset = 0 }) {
	const params = new URLSearchParams();
	if (q) {
		params.set("q", q);
		params.set("limit", String(SEARCH_LIMIT_CD));
		return `/api/clauded-docs/search?${params.toString()}`;
	}
	if (docStatus) params.set("doc_status", docStatus);
	params.set("limit", String(LIST_LIMIT_CD));
	if (offset > 0) params.set("offset", String(offset));
	return `/api/clauded-docs/groups?${params.toString()}`;
}

// /api/clauded-docs/groups response group → row-like 정규화.
//   · group.representative_* 필드를 row.* 로 평탄화 → DocListCardCD 의 기존 row 렌더 코드 재사용 (UI 분기 최소화)
//   · member_count 보존 → row.member_count 가 1 초과 시 group badge 노출 (DocListCardCD 가 사용)
//   · folder_id 보존 → 향후 expand UI 도입 시 fetch helper 사용 (현 scope 외 — single-member groups 가 production 100%)
//   · 사용자 클릭 시 representative_id 의 viewer 진입 (id = representative_id 매핑)
//   · 누락 필드 (content_hash 등) 는 viewer fetch 가 추후 보강 — list row 는 representative_* 만 surface
function normalizeGroupToRowCD(group) {
	if (!group || typeof group !== "object") return null;
	return {
		id: group.representative_id,
		title: group.representative_title,
		author: group.representative_author,
		doc_status: group.representative_doc_status,
		audience: group.representative_audience,
		format: group.representative_format,
		created_at: group.representative_created_at,
		folder_id: group.folder_id,
		member_count: group.member_count,
		// revision-chain 글리프 source — null = chain root (F34).
		supersedes_id:
			typeof group.representative_supersedes_id === "number"
				? group.representative_supersedes_id
				: null,
		// 본문 / hash / 경로는 list row 가 보유하지 않음 — viewer fetch 가 보강.
		content_hash: null,
		html_path: null,
		md_copy_path: null,
		last_synced_at: null,
	};
}

// 에러 envelope 파싱 → describeApiErrorCD 한국어 매핑 진입.
//   · 서버 ClaudedDocsErrorBody enum (not_found / invalid_param / hash_conflict 등) JSON shape → 사용자 친화 메시지.
//   · JSON parse 실패 (truncated · non-JSON 500) → HTTP status + raw 본문 160자 fallback (기존 거동 보존).
//   · AbortError 는 browser fetch 가 그대로 propagate — handleErrorCD 가 swallow (회귀 차단).
async function fetchJsonCD(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		let payload = null;
		let rawText = "";
		try {
			rawText = await res.text();
			payload = JSON.parse(rawText);
		} catch (_e) {
			/* non-JSON 본문 → 아래 fallback */
		}
		if (payload && typeof payload === "object" && payload.error) {
			throw new Error(describeApiErrorCD(payload, res.status));
		}
		throw new Error(
			`HTTP ${res.status} ${res.statusText}${rawText ? " — " + rawText.slice(0, 160) : ""}`,
		);
	}
	return res.json();
}

// AbortError 는 화면 전환 / 필터 변경 — 사용자 가시 실패가 아님.
function handleErrorCD(err, setter) {
	if (err && err.name === "AbortError") return;
	setter({
		status: "error",
		data: null,
		error: err && err.message ? err.message : String(err),
	});
}

// 백엔드 ClaudedDocsErrorBody enum → 사용자 메시지 매핑.
//   · payload.error 는 flat string(enum) 또는 nested object({code,message,details}) 두 형태 —
//     object 형태(HTML 검증 에러)를 string 으로 switch 하면 [object Object] 노출되므로 code/message 선분리.
function describeApiErrorCD(payload, status) {
	if (!payload || typeof payload !== "object") return `HTTP ${status}`;
	const err = payload.error;
	const code = err && typeof err === "object" ? err.code : err;
	const serverMsg = err && typeof err === "object" ? err.message : null;
	switch (code) {
		case "invalid_param":
			return `Invalid parameter (${payload.param})`;
		case "invalid_body":
			return `Invalid input — ${payload.reason || ""}`;
		case "invalid_input":
			return `Invalid input — ${serverMsg || payload.reason || ""}`;
		case "not_found":
			return `Document not found (#${payload.id})`;
		case "audience_invalid":
			return `Invalid audience — ${serverMsg || "not an allowed value"}`;
		case "members_not_found":
			return `Members not found — ${serverMsg || "one or more recipients do not exist"}`;
		case "hash_conflict":
			return "Someone else saved changes first — refresh and try again";
		case "duplicate_content":
			return `Duplicate content — already exists as #${payload.existing_id}`;
		case "conversion_failed":
			return `Conversion failed — ${payload.reason || ""}`;
		case "export_failed":
			return `Export included 0 of ${payload.requested ?? "?"} requested — ${payload.reason || ""}`;
		case "database_unavailable":
			return "Database connection failed";
		case "filesystem_unavailable":
			return `File system error — ${payload.reason || ""}`;
		default:
			// nested validation error(placeholder_residue 등) → server message 우선 노출, code 는 보조.
			if (serverMsg) return `HTTP ${status} — ${serverMsg}`;
			return `HTTP ${status} — ${code || "unknown"}`;
	}
}

function formatIntCD(value) {
	return (Number(value) || 0).toLocaleString("en-US");
}

// created_at 등 모든 displayed 시각 = 서버 .toISOString() real-UTC instant
// → 브라우저-local getHours/getDate 대신 KST 고정 포맷터 위임 (사용자 지시: 표시 시각 KST 명시).
function formatDateCD(iso) {
	if (!iso) return "—";
	return window.UI.formatKstDate(iso); // → "YYYY-MM-DD" KST
}

function formatDateTimeCD(iso) {
	if (!iso) return "—";
	return window.UI.formatKstDateTime(iso); // → "MM/DD HH:mm" KST
}

// ts_headline 'StartSel=<mark>, StopSel=</mark>' 출력을 React 노드로 변환.
// 화이트리스트: <mark> 단일 태그만 — raw HTML 인젝션 차단 (XSS 방어).
function parseSnippetCD(snippet) {
	if (!snippet) return null;
	const text = String(snippet);
	const matches = Array.from(text.matchAll(/<mark>([\s\S]*?)<\/mark>/g));
	const out = [];
	let cursor = 0;
	let key = 0;
	for (const m of matches) {
		if (m.index > cursor) out.push(text.slice(cursor, m.index));
		out.push(<mark key={`m${key++}`}>{m[1]}</mark>);
		cursor = m.index + m[0].length;
	}
	if (cursor < text.length) out.push(text.slice(cursor));
	return out;
}

// R6 본문 렌더 helpers — DOMPurify + DOMParser + React 트리.
//   · iframe srcdoc + sandbox 경로 폐기 사유 — Tailwind CDN JIT 차단 시 utility class 묵시 no-op.
//   · 본문 HTML → React 트리 변환 → host 컨텍스트 Tailwind JIT 가 className 스캔 → CSS 정상 생성.
//   · 보안 layer 2 (server sanitize 후 client 재-sanitize) — defense-in-depth.

// MD primary 판별 — format/html_path 기반 (format 단일 신호).
//   · short-circuit — format ∈ {yaml, json, txt} 은 code viewer 분기 (아래 isCodeFormatDocCD) 로 위임.
//   · html_path .md 종료 → MD primary (server 가 .md 파일 저장 · format=md primary 신호).
//   · 그 외는 HTML primary 유지 (htmlToReactCD 경로).
function isMdPrimaryDocCD(doc) {
	if (!doc) return false;
	if (doc.format === "yaml" || doc.format === "json" || doc.format === "txt")
		return false;
	if (doc.format === "md") return true;
	if (typeof doc.html_path === "string" && /\.md$/i.test(doc.html_path))
		return true;
	return false;
}

// code viewer 분기 판별 — format ∈ {yaml, json, txt}.
//   · server response envelope 의 doc.format 필드 신뢰 (GetClaudedDocResponse · routes/clauded-docs.ts L770-802)
//   · yaml/json → highlight.js syntax highlighting (CDN 로드 · ViewerBodyCD post-render hook)
//   · txt → plain monospace (highlight 불요 · language class 미부여)
function isCodeFormatDocCD(doc) {
	if (!doc) return false;
	return doc.format === "yaml" || doc.format === "json" || doc.format === "txt";
}

// code viewer renderer — yaml/json/txt 본문을 <pre><code class="language-{format}"> 으로 마운트.
//   · htmlToReactCD 반환 shape 와 정합 — { className, style, children } → 호출처가 컨테이너로 lift
//   · React text child 로 본문 전달 — XSS 방어 layer 보존 (raw HTML 인젝션 경로 0)
//   · txt 는 language class 미부여 → highlight.js auto-detect skip (plain monospace 출력)
//   · data-format attribute → post-render hook 가 querySelectorAll 로 노드 식별
//   · body className 'bg-zinc-950 text-zinc-300 antialiased' = dark base 정합 (HTML/MD primary 와 시각 일관)
function renderCodeFormatCD(body, format, _scopeClass) {
	const text =
		typeof body === "string" ? body : String(body == null ? "" : body);
	const langClass = format === "txt" ? "" : `language-${format}`;
	return {
		className: "bg-zinc-950 text-zinc-300 antialiased",
		style: null,
		children: [
			React.createElement(
				"pre",
				{ key: "code-pre", className: "doc-code-pre" },
				React.createElement(
					"code",
					{ key: "code", className: langClass, "data-format": format },
					text,
				),
			),
		],
	};
}

// YAML frontmatter strip — `---\n...\n---\n` (선행 + 후행 fence) 매칭 시 본문만 잘라냄.
//   · 본문이 '---\n' (또는 '---\r\n') 으로 시작하지 않으면 strip 안 함
//   · 닫는 fence 미발견 시 strip 안 함 (방어적 — 전체를 MD 로 렌더)
//   · audience / agent / tokens_estimate 등 glass-atrium-intel-reporter 메타가 사용자 가시화 차단 대상
function stripYamlFrontmatterCD(md) {
	if (typeof md !== "string" || md.length === 0) return "";
	const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!m) return md;
	return md.slice(m[0].length);
}

// MD → HTML 변환 후 dark base default 정합 Tailwind utility class 주입.
//   · marked.parse 결과는 plain HTML (h1/h2/p/ul/ol/li/code/pre/table/blockquote/hr/a/strong/em) — class 없음
//   · 호스트 Tailwind CDN JIT 가 className 을 스캔 → utility CSS 동적 생성 (HTML primary 와 동일 메커니즘)
//   · 시각 일관성 — HTML primary doc 본문과 동일한 zinc dark hue / 위계 (h1 >> h2 > h3 > body)
//   · 정규식 단순 치환 — marked output 은 well-formed (closing tag predictable), 후속 DOMPurify pass 가 안전망
function injectMdTypographyClassesCD(html) {
	if (typeof html !== "string" || html.length === 0) return "";
	// class="..." 형태 — opening tag 만 매칭 (closing </tag> 영향 없음). 기존 attr 가 있을 가능성은 marked default 출력에서 없음 (헤딩 id 는 marked 가 자동 부여하지 않음 — 별도 slugger 미사용).
	// marked v13 default 는 anchor id 미주입 — heading id 충돌 우려 0.
	return (
		html
			.replace(
				/<h1>/g,
				'<h1 class="text-2xl font-bold text-zinc-100 mt-8 mb-4">',
			)
			.replace(
				/<h2>/g,
				'<h2 class="text-xl font-semibold text-zinc-200 mt-6 mb-3">',
			)
			.replace(
				/<h3>/g,
				'<h3 class="text-lg font-semibold text-zinc-200 mt-4 mb-2">',
			)
			.replace(
				/<h4>/g,
				'<h4 class="text-base font-semibold text-zinc-200 mt-3 mb-2">',
			)
			.replace(
				/<h5>/g,
				'<h5 class="text-sm font-semibold text-zinc-200 mt-2 mb-1">',
			)
			.replace(
				/<h6>/g,
				'<h6 class="text-sm font-semibold text-zinc-300 mt-2 mb-1">',
			)
			.replace(/<p>/g, '<p class="text-zinc-400 leading-[1.75] mb-4">')
			.replace(
				/<ul>/g,
				'<ul class="text-zinc-400 list-disc pl-6 mb-4 space-y-1">',
			)
			.replace(
				/<ol>/g,
				'<ol class="text-zinc-400 list-decimal pl-6 mb-4 space-y-1">',
			)
			.replace(/<li>/g, '<li class="text-zinc-400">')
			.replace(
				/<pre>/g,
				'<pre class="bg-zinc-900 border border-zinc-800 rounded p-3 overflow-x-auto mb-4 text-sm">',
			)
			.replace(
				/<code>/g,
				'<code class="bg-zinc-900 text-zinc-300 px-1 rounded text-sm font-mono">',
			)
			.replace(/<table>/g, '<table class="border-collapse w-full mb-4">')
			.replace(/<thead>/g, '<thead class="bg-zinc-900">')
			.replace(
				/<th>/g,
				'<th class="text-left p-2 border border-zinc-800 text-zinc-200 font-semibold">',
			)
			.replace(
				/<td>/g,
				'<td class="text-left p-2 border border-zinc-800 text-zinc-400">',
			)
			.replace(
				/<blockquote>/g,
				'<blockquote class="border-l-4 border-zinc-700 pl-4 italic text-zinc-400 mb-4">',
			)
			.replace(/<hr>/g, '<hr class="border-zinc-800 my-6">')
			.replace(/<hr\/>/g, '<hr class="border-zinc-800 my-6"/>')
			.replace(/<strong>/g, '<strong class="text-zinc-200 font-semibold">')
			.replace(/<em>/g, '<em class="text-zinc-300 italic">')
			// <a href="..."> — href attr 보존 + className 추가. R6 anchor onClick / external rel 은 htmlToReactCD 가 처리.
			.replace(
				/<a(\s+href="[^"]*")>/g,
				'<a$1 class="text-blue-400 hover:text-blue-300 underline">',
			)
			// <pre><code class="language-xxx"> — marked code fence 출력. 내부 code 의 bg/padding 제거 (pre 가 이미 어두운 배경).
			// marked v13 default 는 fenced code 에 'language-xxx' class 부여 (highlight 라이브러리 hook). bg 충돌 회피 — code 의 bg-zinc-900 px-1 rounded 가 pre 내부에서 시각 노이즈.
			// 단순 처리: <pre><code 형태 매칭 시 code 의 inline bg 클래스 제거 (text class 만 유지).
			.replace(
				/<pre class="([^"]*)"><code class="bg-zinc-900 text-zinc-300 px-1 rounded text-sm font-mono">/g,
				'<pre class="$1"><code class="text-zinc-300 text-sm font-mono">',
			)
			.replace(
				/<pre class="([^"]*)"><code class="bg-zinc-900 text-zinc-300 px-1 rounded text-sm font-mono ([^"]*)">/g,
				'<pre class="$1"><code class="text-zinc-300 text-sm font-mono $2">',
			)
	);
}

// MD body → React 트리 변환.
//   1. window.marked 가용성 확인 (CDN 실패 시 throw → 호출처 ErrorBanner)
//   2. YAML frontmatter strip (audience / agent / tokens_estimate 노출 차단)
//   3. marked.parse — GFM 활성 (tables / fenced code / autolinks) · breaks=false (단일 newline 가 <br> 변환 차단 — 한국어 prose semantic newline)
//   4. dark base default Tailwind utility class 주입
//   5. <body> wrapper 로 감싸 htmlToReactCD 가 body className 을 컨테이너로 lift → bg-zinc-950 적용
//   6. htmlToReactCD chain — DOMPurify sanitize → DOMParser → React.createElement (방어층 재사용)
function renderMarkdownCD(mdBody, scopeClass) {
	if (
		typeof window === "undefined" ||
		!window.marked ||
		typeof window.marked.parse !== "function"
	) {
		throw new Error("marked library unavailable");
	}
	const stripped = stripYamlFrontmatterCD(String(mdBody || ""));
	// gfm=true → tables / strikethrough / autolink 활성. breaks=false → 한국어 prose semantic newline 보존.
	// marked default 가 raw HTML inline pass-through 허용 — DOMPurify 가 후속 sanitize 로 backstop.
	const rawHtml = window.marked.parse(stripped, { gfm: true, breaks: false });
	if (typeof rawHtml !== "string") {
		throw new Error("marked.parse returned non-string");
	}
	const classed = injectMdTypographyClassesCD(rawHtml);
	// body wrapper — htmlToReactCD 가 body className 을 컨테이너로 lift (HTML primary 와 동일 메커니즘).
	// bg-zinc-950 text-zinc-300 antialiased = dark base default (사용자 directive + AA contrast 톤다운).
	const wrapped = `<body class="bg-zinc-950 text-zinc-300 antialiased"><article>${classed}</article></body>`;
	return htmlToReactCD(wrapped, scopeClass);
}

// 진입 — htmlToReactCD(htmlString, scopeClass)
//   반환:
//     · 성공: { className: string, style: object|null, children: ReactNode[] }
//     · DOMPurify/DOMParser 부재 또는 throw: null (호출처가 ErrorBanner 렌더)
//
// 자가 테스트:
//   콘솔에서 `window.__claudedDocsTest = true; location.reload()` → reload 직후 콘솔 결과 확인.
//   테스트 케이스: <script> · onerror · javascript: URL · <svg onload> · <style body{}> 스코핑 · Tailwind className · <iframe srcdoc>.

// DOMPurify config — 화이트리스트 외 태그/속성 통째 차단.
// FORBID_TAGS: script (내용 포함) · iframe (srcdoc 중첩 포함) · object · embed · base · meta · link.
// FORBID_ATTR: on* 인라인 이벤트 + formaction (form 하이재킹).
// ALLOW_UNKNOWN_PROTOCOLS=false → javascript: / data: URL 차단.
// KEEP_CONTENT=true → 제거된 태그의 텍스트 내용은 유지 (단 script 내용은 default 로 제거됨).
// WHOLE_DOCUMENT=true → <html>/<head>/<body> 보존 (default 는 body unwrap → class 유실). body className lift 가능.
const DOMPURIFY_CONFIG_CD = {
	FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta", "link"],
	FORBID_ATTR: [
		"onerror",
		"onload",
		"onclick",
		"onmouseover",
		"onfocus",
		"onblur",
		"onchange",
		"oninput",
		"onsubmit",
		"onreset",
		"onselect",
		"onkeydown",
		"onkeyup",
		"onkeypress",
		"onabort",
		"oncanplay",
		"oncanplaythrough",
		"ondurationchange",
		"onemptied",
		"onended",
		"onloadeddata",
		"onloadedmetadata",
		"onloadstart",
		"onpause",
		"onplay",
		"onplaying",
		"onprogress",
		"onratechange",
		"onseeked",
		"onseeking",
		"onstalled",
		"onsuspend",
		"ontimeupdate",
		"onvolumechange",
		"onwaiting",
		"onanimationstart",
		"onanimationend",
		"onanimationiteration",
		"ontransitionend",
		"formaction",
	],
	ALLOW_UNKNOWN_PROTOCOLS: false,
	KEEP_CONTENT: true,
	WHOLE_DOCUMENT: true,
};

// HTML attribute → React prop 매핑 (DOMPurify 통과 attr 만 처리 — 화이트리스트 추가 sanitize 후 React 가 받음).
const HTML_TO_REACT_ATTR_CD = {
	class: "className",
	for: "htmlFor",
	tabindex: "tabIndex",
	readonly: "readOnly",
	maxlength: "maxLength",
	minlength: "minLength",
	autocomplete: "autoComplete",
	autofocus: "autoFocus",
	colspan: "colSpan",
	rowspan: "rowSpan",
	cellpadding: "cellPadding",
	cellspacing: "cellSpacing",
	crossorigin: "crossOrigin",
	enctype: "encType",
	novalidate: "noValidate",
	srcdoc: "srcDoc",
	spellcheck: "spellCheck",
	contenteditable: "contentEditable",
};

// 본문 HTML → { className, style, children } 변환.
// React 트리 반환 — 호출처가 컨테이너에 className/style lift 후 children 마운트.
// 실패 시 null — silent fallback 금지 (호출처가 ErrorBanner 표시).
function htmlToReactCD(htmlString, scopeClass) {
	if (typeof htmlString !== "string" || htmlString.length === 0) return null;
	const purifier = window.DOMPurify;
	if (!purifier || typeof purifier.sanitize !== "function") return null;
	if (typeof DOMParser === "undefined") return null;

	try {
		const sanitized = purifier.sanitize(htmlString, DOMPURIFY_CONFIG_CD);
		if (typeof sanitized !== "string") return null;
		const dom = new DOMParser().parseFromString(sanitized, "text/html");
		if (!dom || !dom.documentElement) return null;

		// <body> 의 className/style 을 호출처 컨테이너로 lift → utility class (bg-zinc-950 등) 적용.
		const bodyEl = dom.body;
		let liftedClassName = "";
		let liftedStyle = null;
		if (bodyEl) {
			liftedClassName = bodyEl.getAttribute("class") || "";
			const inlineStyle = bodyEl.getAttribute("style");
			if (inlineStyle) liftedStyle = parseInlineStyleCD(inlineStyle);
		}

		// <head> + <body> 자식을 flatten — html/head/body wrapper 자체는 buffer 로만 사용.
		const children = [];
		const headChildren = dom.head ? Array.from(dom.head.childNodes) : [];
		const bodyChildren = bodyEl ? Array.from(bodyEl.childNodes) : [];
		const allNodes = headChildren.concat(bodyChildren);
		for (let i = 0; i < allNodes.length; i++) {
			const converted = convertNodeCD(allNodes[i], scopeClass, `r${i}`);
			if (converted != null) children.push(converted);
		}

		return { className: liftedClassName, style: liftedStyle, children };
	} catch (_e) {
		return null;
	}
}

// React 가 직접 text child 를 거부하는 부모 태그 집합 — DOM nesting validation rule.
//   · table/thead/tbody/tfoot/tr/colgroup — table content model 은 whitespace text 허용 안 함
//   · select/optgroup — option 외 child 거부
//   · HTML source 의 들여쓰기 (`<table>\n  <thead>`) 가 DOMParser 단계에서 text node 로 보존 →
//     React 가 validateDOMNesting 경고 발생 → 본 set 의 자식인 whitespace-only text 는 drop.
//   · 비-whitespace text 는 보존 — 사용자 의도된 텍스트 (희귀, 사실상 invalid HTML) 까지 silent suppress 금지.
const NO_TEXT_CHILD_PARENTS_CD = new Set([
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"colgroup",
	"select",
	"optgroup",
]);

// DOM node → React node 재귀 변환.
//   - TEXT_NODE → string (React 가 텍스트로 렌더) · 단, 부모가 table-family 면 whitespace-only 는 drop
//   - ELEMENT_NODE → React.createElement
//   - COMMENT/PROCESSING_INSTRUCTION → null
//   - <style> → 셀렉터 prefix scoping 후 React <style> 엘리먼트
//   - <script> → null (DOMPurify 가 이미 제거; defensive)
function convertNodeCD(node, scopeClass, keyPath) {
	if (!node) return null;
	const TEXT = 3,
		ELEMENT = 1;

	if (node.nodeType === TEXT) {
		const text = node.textContent;
		// whitespace-only text + table-family 부모 → drop (validateDOMNesting 회피)
		if (typeof text === "string" && /^\s*$/.test(text)) {
			const parentTag =
				node.parentNode && node.parentNode.tagName
					? node.parentNode.tagName.toLowerCase()
					: "";
			if (NO_TEXT_CHILD_PARENTS_CD.has(parentTag)) return null;
		}
		return text;
	}
	if (node.nodeType !== ELEMENT) return null;

	const tag = (node.tagName || "").toLowerCase();
	if (!tag) return null;
	if (tag === "script") return null;

	// <style> — 셀렉터 scoping 후 React 엘리먼트로 반환. children 으로 CSS 문자열 전달 (innerHTML 아님).
	if (tag === "style") {
		const css = node.textContent || "";
		const scoped = scopeCssRulesCD(css, scopeClass);
		return React.createElement("style", { key: keyPath }, scoped);
	}

	// 일반 엘리먼트 — attribute 변환 + 자식 재귀.
	const props = { key: keyPath };
	let hrefValue = null; // <a> 처리용 — href raw value 보관
	let targetIsBlank = false; // target="_blank" 보안 hygiene flag
	if (node.attributes) {
		for (let i = 0; i < node.attributes.length; i++) {
			const attr = node.attributes[i];
			const name = (attr.name || "").toLowerCase();
			const value = attr.value;

			// 인라인 이벤트 핸들러 defensive drop — DOMPurify FORBID_ATTR 화이트리스트 이중 방어.
			if (name.startsWith("on")) continue;

			// javascript: URL defensive drop — DOMPurify ALLOW_UNKNOWN_PROTOCOLS=false 이중 방어.
			if (
				(name === "href" ||
					name === "src" ||
					name === "action" ||
					name === "formaction") &&
				typeof value === "string" &&
				/^\s*javascript\s*:/i.test(value)
			) {
				continue;
			}

			// style — CSS 문자열을 React style 객체로 변환.
			if (name === "style") {
				const parsed = parseInlineStyleCD(value);
				if (parsed) props.style = parsed;
				continue;
			}

			// <a> href / target 추적 — 후속 onClick / rel 주입 결정용.
			if (tag === "a" && name === "href" && typeof value === "string") {
				hrefValue = value;
			}
			if (
				tag === "a" &&
				name === "target" &&
				typeof value === "string" &&
				value.toLowerCase() === "_blank"
			) {
				targetIsBlank = true;
			}

			// class → className 같은 React 명칭 매핑.
			const reactName = HTML_TO_REACT_ATTR_CD[name] || name;
			props[reactName] = value === "" ? true : value;
		}
	}

	// <a href="#fragment"> 클릭 가로채기 — host hash router (app.jsx) 와의 충돌 방지.
	//   - 원인: 본문 anchor 클릭 → 브라우저가 location.hash 변경 → app.jsx 의 hashchange 리스너가 NAV 미매칭 fragment 를 dashboard fallback 으로 라우팅 → 뷰어 unmount.
	//   - 해법: SVG 외부의 <a> 에 한해 onClick 으로 scoped scrollIntoView 만 수행 — location.hash / history 미터치.
	//   - href 속성 보존 — 우클릭 "링크 복사" / 외부 북마크 호환 (보안 영향 없음, hash 값 자체는 동일 origin sub-uri).
	//   - 외부 링크 (#로 시작 아님) 는 native 처리 — target="_blank" 시 rel="noopener noreferrer" 보강 (reverse-tabnabbing 차단, core-security.md A05).
	if (tag === "a") {
		if (
			typeof hrefValue === "string" &&
			hrefValue.length > 1 &&
			hrefValue.charAt(0) === "#"
		) {
			const targetId = hrefValue.slice(1);
			props.onClick = function handleAnchorJumpCD(e) {
				e.preventDefault();
				e.stopPropagation();
				const scopeEl =
					e.currentTarget && e.currentTarget.closest
						? e.currentTarget.closest(`.${scopeClass}`)
						: null;
				if (!scopeEl) return;
				let targetEl = null;
				try {
					const selector =
						"#" +
						(typeof window !== "undefined" &&
						window.CSS &&
						typeof window.CSS.escape === "function"
							? window.CSS.escape(targetId)
							: targetId);
					targetEl = scopeEl.querySelector(selector);
				} catch (_err) {
					targetEl = null;
				}
				if (!targetEl) return;
				// prefers-reduced-motion 명시 분기 — modern 브라우저는 auto 처리하나 defensive.
				const reduceMotion =
					typeof window !== "undefined" &&
					typeof window.matchMedia === "function" &&
					window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				targetEl.scrollIntoView({
					behavior: reduceMotion ? "auto" : "smooth",
					block: "start",
				});
			};
		} else if (targetIsBlank) {
			// 외부 링크 + target="_blank" → reverse-tabnabbing 차단 (window.opener null).
			const existingRel = typeof props.rel === "string" ? props.rel : "";
			const tokens = existingRel.toLowerCase().split(/\s+/).filter(Boolean);
			if (tokens.indexOf("noopener") < 0) tokens.push("noopener");
			if (tokens.indexOf("noreferrer") < 0) tokens.push("noreferrer");
			props.rel = tokens.join(" ");
		}
	}

	// 자식 재귀 — sibling 마다 안정적 key path 부여 (Math.random 금지).
	const children = [];
	const cnodes = node.childNodes;
	for (let i = 0; i < cnodes.length; i++) {
		const child = convertNodeCD(cnodes[i], scopeClass, `${keyPath}.${i}`);
		if (child != null) children.push(child);
	}

	// void element (br/hr/img/input 등) 는 children 없이 호출.
	if (children.length === 0) {
		return React.createElement(tag, props);
	}
	return React.createElement(tag, props, ...children);
}

// CSS 'background-color: red; font-size: 14px' → { backgroundColor: 'red', fontSize: '14px' }.
//   - kebab-case property → camelCase (vendor prefix -webkit- → WebkitTransform 등은 React 가 처리)
//   - '!important' 토큰 제거 (React style 객체는 important 무인식)
//   - CSS 변수 (--foo) 는 그대로 유지 (React 18+ 지원)
function parseInlineStyleCD(cssText) {
	if (!cssText || typeof cssText !== "string") return null;
	const out = {};
	const decls = cssText.split(";");
	for (let i = 0; i < decls.length; i++) {
		const decl = decls[i].trim();
		if (!decl) continue;
		const idx = decl.indexOf(":");
		if (idx < 0) continue;
		const prop = decl.slice(0, idx).trim();
		let value = decl.slice(idx + 1).trim();
		if (!prop) continue;
		value = value.replace(/\s*!important\s*$/i, "");
		const reactProp = prop.startsWith("--")
			? prop
			: prop.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
		out[reactProp] = value;
	}
	return Object.keys(out).length > 0 ? out : null;
}

// CSS source → 셀렉터 prefix scoping 결과 CSS source.
//   - 'body { ... }' → '.${scopeClass} { ... }'
//   - 'p { ... }' → '.${scopeClass} p { ... }'
//   - '@media (...) { p { ... } }' → '@media (...) { .${scopeClass} p { ... } }'
//   - '@keyframes foo { 0% { ... } 100% { ... } }' → 내부 step 은 prefix 안 함 (CSS spec)
//   - '@font-face' / '@import' → prefix 안 함 (top-level 유지)
//
// 상태 머신 — regex 단독은 nested brace 처리 불가. depth-counted scanner 로 안전 처리.
function scopeCssRulesCD(cssSource, scopeClass) {
	if (!cssSource || typeof cssSource !== "string") return "";
	if (!scopeClass) return cssSource;

	const src = cssSource;
	const len = src.length;
	const scopeSel = `.${scopeClass}`;
	const out = [];
	let i = 0;

	// 톱-레벨 토큰화 — selector list / at-rule / brace block 단위.
	while (i < len) {
		// 공백 / 주석 skip.
		while (i < len && /\s/.test(src[i])) {
			out.push(src[i]);
			i++;
		}
		if (i >= len) break;
		if (src[i] === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end < 0 ? len : end + 2;
			out.push(src.slice(i, stop));
			i = stop;
			continue;
		}

		if (src[i] === "@") {
			// @-rule — at-keyword 추출. 문자열 / URL 내 '{' / ';' 무시.
			const start = i;
			while (i < len) {
				const ch = src[i];
				if (ch === '"' || ch === "'") {
					const quote = ch;
					i++;
					while (i < len && src[i] !== quote) {
						if (src[i] === "\\") i++;
						i++;
					}
					if (i < len) i++; // closing quote.
					continue;
				}
				if (ch === "/" && src[i + 1] === "*") {
					const end = src.indexOf("*/", i + 2);
					i = end < 0 ? len : end + 2;
					continue;
				}
				if (ch === "{" || ch === ";") break;
				i++;
			}
			const prelude = src.slice(start, i);
			const atKeyword = (prelude.match(/^@(-\w+-)?[\w-]+/) || [""])[0]
				.toLowerCase()
				.replace(/^@(-\w+-)?/, "@");

			if (i < len && src[i] === ";") {
				// @import / @charset / @namespace — top-level statement, prefix 안 함.
				out.push(prelude);
				out.push(";");
				i++;
				continue;
			}

			if (i >= len) {
				out.push(prelude);
				break;
			}

			// '{' — block 시작. nested rule 가 안에 있는지 keyword 로 분기.
			const nestedRulesInside =
				atKeyword === "@media" ||
				atKeyword === "@supports" ||
				atKeyword === "@container" ||
				atKeyword === "@layer" ||
				atKeyword === "@document" ||
				atKeyword === "@scope";
			const innerStart = i + 1;
			const innerEnd = findMatchingBraceCD(src, i);
			if (innerEnd < 0) {
				// 미매칭 brace — 안전하게 원본 그대로 append + 종료.
				out.push(src.slice(start));
				i = len;
				break;
			}
			out.push(prelude);
			out.push("{");
			const innerCss = src.slice(innerStart, innerEnd);
			if (nestedRulesInside) {
				// @media 등 — 내부에서 다시 scopeCssRulesCD 재귀 (nested rule prefix).
				out.push(scopeCssRulesCD(innerCss, scopeClass));
			} else {
				// @keyframes / @font-face / @page 등 — 내부 prefix 안 함 (CSS spec).
				out.push(innerCss);
			}
			out.push("}");
			i = innerEnd + 1;
			continue;
		}

		// 일반 rule — selector list { declarations }. 문자열 / 주석 내 '{' 무시.
		const selStart = i;
		let braceAt = -1;
		while (i < len) {
			const ch = src[i];
			if (ch === '"' || ch === "'") {
				const quote = ch;
				i++;
				while (i < len && src[i] !== quote) {
					if (src[i] === "\\") i++;
					i++;
				}
				if (i < len) i++;
				continue;
			}
			if (ch === "/" && src[i + 1] === "*") {
				const end = src.indexOf("*/", i + 2);
				i = end < 0 ? len : end + 2;
				continue;
			}
			if (ch === "{") {
				braceAt = i;
				break;
			}
			if (ch === "}") break;
			i++;
		}
		if (braceAt < 0) {
			// selector 만 있고 brace 없음 — 손상 input 으로 간주, 그대로 append.
			out.push(src.slice(selStart, i));
			continue;
		}

		const selectorList = src.slice(selStart, braceAt);
		const blockEnd = findMatchingBraceCD(src, braceAt);
		if (blockEnd < 0) {
			out.push(src.slice(selStart));
			i = len;
			break;
		}
		const declarations = src.slice(braceAt + 1, blockEnd);

		// selector 리스트 (콤마 split) 각각 prefix.
		const prefixed = selectorList
			.split(",")
			.map((sel) => prefixSelectorCD(sel.trim(), scopeSel))
			.filter((s) => s.length > 0)
			.join(", ");

		out.push(prefixed);
		out.push(" { ");
		out.push(declarations);
		out.push(" }");
		i = blockEnd + 1;
	}

	return out.join("");
}

// 단일 selector → scope 접두 적용.
//   - 'body' / 'html' → scopeSel 단독
//   - 'body p' / 'html div.foo' → 'scopeSel p' / 'scopeSel div.foo' (root 치환)
//   - 'p.foo' → 'scopeSel p.foo' (descendant prefix)
//   - ':root' → scopeSel 단독 (CSS custom prop scope 호환)
//   - 빈 문자열 / '*' → 그대로 처리.
function prefixSelectorCD(sel, scopeSel) {
	if (!sel) return "";
	const trimmed = sel.trim();
	if (!trimmed) return "";
	if (trimmed === "body" || trimmed === "html" || trimmed === ":root")
		return scopeSel;
	if (/^body\s+/i.test(trimmed)) return scopeSel + trimmed.slice(4);
	if (/^html\s+/i.test(trimmed)) return scopeSel + trimmed.slice(4);
	if (/^:root\s+/i.test(trimmed)) return scopeSel + trimmed.slice(5);
	return `${scopeSel} ${trimmed}`;
}

// '{' 위치 → 매칭 '}' 위치 반환. 미매칭 시 -1.
//   - 문자열 리터럴 / 주석 안의 brace 는 무시.
function findMatchingBraceCD(src, openIdx) {
	if (src[openIdx] !== "{") return -1;
	let depth = 0;
	const len = src.length;
	for (let i = openIdx; i < len; i++) {
		const ch = src[i];
		if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			while (i < len && src[i] !== quote) {
				if (src[i] === "\\") i++;
				i++;
			}
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// 자가 테스트 — window.__claudedDocsTest=true 시 콘솔에 결과 출력.
// 케이스: script · img onerror · javascript: URL · svg onload · style body{} 스코핑 · Tailwind className · iframe srcdoc · DOMPurify 부재 · anchor onClick 주입 · 외부 링크 native + rel · href 보존.
function runClaudedDocsViewerTestsCD() {
	const results = [];
	const expect = (name, cond, detail) => {
		results.push({ name, pass: !!cond, detail: detail || "" });
	};
	const before = window.XSS_FIRED;

	// 1. <script>window.XSS_FIRED = true</script>
	{
		delete window.XSS_FIRED;
		const r = htmlToReactCD(
			"<body><p>before</p><script>window.XSS_FIRED = true</script><p>after</p></body>",
			DOC_BODY_SCOPE_CD,
		);
		expect(
			"1. <script> tag stripped + content not executed",
			r != null && window.XSS_FIRED !== true,
			`XSS_FIRED=${window.XSS_FIRED}`,
		);
	}

	// 2. <img src=x onerror="window.XSS_FIRED = true">
	{
		delete window.XSS_FIRED;
		const r = htmlToReactCD(
			'<body><img src="x" onerror="window.XSS_FIRED = true"></body>',
			DOC_BODY_SCOPE_CD,
		);
		// onerror attr 가 없어야 하므로 다음 mount 에서도 실행 불가. 트리 자체 검사:
		const imgNode = r && r.children.find((c) => c && c.type === "img");
		const hasOnError =
			imgNode &&
			imgNode.props &&
			(imgNode.props.onerror || imgNode.props.onError);
		expect(
			"2. <img onerror> attribute dropped",
			!hasOnError,
			hasOnError ? "onerror leaked" : "",
		);
	}

	// 3. <a href="javascript:..."> — href 가 javascript: 로 시작하면 안 됨.
	{
		const r = htmlToReactCD(
			'<body><a href="javascript:void(window.XSS_FIRED = true)">click</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const href = aNode && aNode.props && aNode.props.href;
		const startsWithJs = typeof href === "string" && /^javascript:/i.test(href);
		expect("3. javascript: URL stripped", !startsWithJs, `href=${href}`);
	}

	// 4. <svg onload="...">
	{
		delete window.XSS_FIRED;
		const r = htmlToReactCD(
			'<body><svg onload="window.XSS_FIRED = true"></svg></body>',
			DOC_BODY_SCOPE_CD,
		);
		const svgNode = r && r.children.find((c) => c && c.type === "svg");
		const hasOnLoad =
			svgNode &&
			svgNode.props &&
			(svgNode.props.onload || svgNode.props.onLoad);
		expect(
			"4. <svg onload> attribute dropped",
			!hasOnLoad,
			hasOnLoad ? "onload leaked" : "",
		);
	}

	// 5. <style>body { background: red !important }</style> — host body 비영향.
	{
		const r = htmlToReactCD(
			"<body><style>body { background: red !important }</style></body>",
			DOC_BODY_SCOPE_CD,
		);
		const styleNode = r && r.children.find((c) => c && c.type === "style");
		const css =
			styleNode && typeof styleNode.props.children === "string"
				? styleNode.props.children
				: "";
		const containsBareBody = /(^|[^.\w-])body\s*\{/.test(css);
		const containsScoped = css.indexOf(`.${DOC_BODY_SCOPE_CD}`) >= 0;
		expect(
			"5. <style> body selector scoped to container",
			!containsBareBody && containsScoped,
			`css="${css}"`,
		);
	}

	// 6. <p class="text-zinc-400"> — className 이 React props 로 전달됨.
	{
		const r = htmlToReactCD(
			'<body><p class="text-zinc-400">test</p></body>',
			DOC_BODY_SCOPE_CD,
		);
		const pNode = r && r.children.find((c) => c && c.type === "p");
		const hasClassName =
			pNode && pNode.props && pNode.props.className === "text-zinc-400";
		expect(
			"6. Tailwind className passed as React prop",
			hasClassName,
			`className=${pNode && pNode.props ? pNode.props.className : "undefined"}`,
		);
	}

	// 7. <iframe srcdoc="..."> — iframe 통째 제거.
	{
		const r = htmlToReactCD(
			'<body><iframe srcdoc="<script>parent.XSS_FIRED=true</script>"></iframe></body>',
			DOC_BODY_SCOPE_CD,
		);
		const iframeNode = r && r.children.find((c) => c && c.type === "iframe");
		expect(
			"7. <iframe> stripped entirely",
			!iframeNode,
			iframeNode ? "iframe survived" : "",
		);
	}

	// 8. DOMPurify 부재 — null 반환.
	{
		const saved = window.DOMPurify;
		window.DOMPurify = undefined;
		const r = htmlToReactCD("<body><p>x</p></body>", DOC_BODY_SCOPE_CD);
		window.DOMPurify = saved;
		expect("8. DOMPurify absent → null (no silent fallback)", r === null);
	}

	// 9. <a href="#summary"> — onClick 주입 + href 보존 (host hash router 충돌 방지).
	{
		const r = htmlToReactCD(
			'<body><a href="#summary">Summary</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const hasOnClick =
			aNode && aNode.props && typeof aNode.props.onClick === "function";
		const hrefPreserved =
			aNode && aNode.props && aNode.props.href === "#summary";
		expect(
			"9. fragment anchor — onClick injected + href preserved",
			hasOnClick && hrefPreserved,
			`onClick=${hasOnClick} href=${aNode && aNode.props ? aNode.props.href : "undefined"}`,
		);
	}

	// 10. <a href="https://example.com"> — onClick 미주입 (native 동작).
	{
		const r = htmlToReactCD(
			'<body><a href="https://example.com">ext</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const noOnClick =
			aNode && aNode.props && typeof aNode.props.onClick !== "function";
		expect(
			"10. external link — onClick NOT injected",
			noOnClick,
			`onClick=${aNode && aNode.props ? typeof aNode.props.onClick : "no-node"}`,
		);
	}

	// 11. <a href="https://x" target="_blank"> — rel="noopener noreferrer" 보강.
	{
		const r = htmlToReactCD(
			'<body><a href="https://x" target="_blank">ext</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const rel =
			aNode && aNode.props && typeof aNode.props.rel === "string"
				? aNode.props.rel
				: "";
		const hasNoopener = rel.indexOf("noopener") >= 0;
		const hasNoreferrer = rel.indexOf("noreferrer") >= 0;
		expect(
			"11. target=_blank → rel noopener noreferrer injected",
			hasNoopener && hasNoreferrer,
			`rel="${rel}"`,
		);
	}

	// 12. <a href="#"> (단독 '#') — onClick 미주입 (no-op native 동작 유지).
	{
		const r = htmlToReactCD(
			'<body><a href="#">noop</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const noOnClick =
			aNode && aNode.props && typeof aNode.props.onClick !== "function";
		expect('12. bare "#" href — onClick NOT injected', noOnClick);
	}

	// 13. onClick 동작 — scoped scrollIntoView 호출 + location.hash 미변경 + preventDefault 호출.
	{
		// 가짜 DOM 환경 — 실제 scopeEl + targetEl mock.
		const fakeTarget = { scrollIntoViewCalled: false };
		fakeTarget.scrollIntoView = function (opts) {
			fakeTarget.scrollIntoViewCalled = true;
			fakeTarget.lastOpts = opts;
		};
		const fakeScope = {
			querySelector: (sel) => (sel === "#summary" ? fakeTarget : null),
		};
		let preventCalled = false;
		let stopCalled = false;
		const fakeEvent = {
			preventDefault: () => {
				preventCalled = true;
			},
			stopPropagation: () => {
				stopCalled = true;
			},
			currentTarget: {
				closest: (sel) => (sel === `.${DOC_BODY_SCOPE_CD}` ? fakeScope : null),
			},
		};
		const r = htmlToReactCD(
			'<body><a href="#summary">Summary</a></body>',
			DOC_BODY_SCOPE_CD,
		);
		const aNode = r && r.children.find((c) => c && c.type === "a");
		const hashBefore =
			typeof window !== "undefined" ? window.location.hash : "";
		if (aNode && typeof aNode.props.onClick === "function") {
			aNode.props.onClick(fakeEvent);
		}
		const hashAfter = typeof window !== "undefined" ? window.location.hash : "";
		expect(
			"13. onClick — preventDefault + stopPropagation + scoped scrollIntoView + hash unchanged",
			preventCalled &&
				stopCalled &&
				fakeTarget.scrollIntoViewCalled &&
				hashBefore === hashAfter,
			`prevent=${preventCalled} stop=${stopCalled} scroll=${fakeTarget.scrollIntoViewCalled} hash="${hashBefore}"→"${hashAfter}"`,
		);
	}

	// restore state.
	if (before !== undefined) window.XSS_FIRED = before;
	else delete window.XSS_FIRED;

	// eslint-disable-next-line no-console
	console.group("[clauded-docs viewer R6 self-tests]");
	for (const r of results) {
		// eslint-disable-next-line no-console
		console.log(
			`${r.pass ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`,
		);
	}
	// eslint-disable-next-line no-console
	console.groupEnd();
	return results;
}

// 자가 테스트 진입 — window.__claudedDocsTest=true 시 1회 자동 실행 (idempotent).
if (
	typeof window !== "undefined" &&
	window.__claudedDocsTest === true &&
	!window.__claudedDocsTestRan
) {
	window.__claudedDocsTestRan = true;
	// DOMPurify 로딩 완료 보장 — micro task 로 지연.
	setTimeout(() => {
		try {
			window.__claudedDocsTestResults = runClaudedDocsViewerTestsCD();
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error("[clauded-docs viewer R6 self-tests] runner failed", e);
		}
	}, 0);
}

// 필터 칩 색상 스타일 (대상·진행상태 chips 공용) — active 만 칩 색상, idle 은 line/dim 으로 톤 다운 (60-30-10 분포 유지).
function chipBadgeStyleCD(cssVar, active) {
	if (active) {
		return {
			background: `rgb(var(${cssVar}) / 0.16)`,
			border: `1px solid rgb(var(${cssVar}) / 0.4)`,
			color: `rgb(var(${cssVar}))`,
		};
	}
	return {
		background: "rgb(var(--sunken))",
		border: "1px solid rgb(var(--line))",
		color: "rgb(var(--dim))",
	};
}

function skeletonBlockStyleCD(height) {
	return {
		height,
		borderRadius: 6,
		background: "rgb(var(--sunken))",
		opacity: 0.7,
		animation: "skelPulseCD 1.4s ease-in-out infinite",
	};
}

window.ScreenClaudedDocs = ScreenClaudedDocs;
