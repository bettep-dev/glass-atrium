// Fixes the day-bucket zone to a non-UTC one for a suite whose window-edge seeds must tell a bucket-tz cut from
// a UTC cut. timezone.ts reads ATRIUM_TIMEZONE once at module load, so a suite imports this before any src module.
export const PINNED_BUCKET_TIMEZONE = "Asia/Seoul";

process.env.ATRIUM_TIMEZONE = PINNED_BUCKET_TIMEZONE;
