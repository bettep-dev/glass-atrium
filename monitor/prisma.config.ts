// Prisma 7 config — datasource block 의 deprecated `url` 필드를 CLI 용으로 대체.
// v7 은 `.env` auto-load 안 함 → `dotenv/config` 가 로드하고 CLI 는 env() helper 로 연결문자열 읽음.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Unix-socket-only auth. DATABASE_URL = postgresql://$USER@localhost/glass_atrium?host=/tmp
    // `host=/tmp` query param 이 libpq 를 Unix socket 디렉터리로 라우팅 → `localhost` host segment 무시
    url: env("DATABASE_URL"),
    // Shadow DB — raw-SQL tsvector GENERATED 컬럼(wiki.notes/monitor.documents)이 매 migrate dev 마다 drift 로 오인되는 문제 차단
    // 별도 DB(`glass_atrium_shadow`)에 migrations/ replay 후 schema.prisma 비교 → 양쪽 모두 raw-SQL 결과 포함 → false drift 0
    shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
  },
});
