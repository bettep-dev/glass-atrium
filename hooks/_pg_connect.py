# Connect tolerance of the hook database writers, in a stdlib-only module.
#
# Beside the writers rather than in one of them: each writer imports its own driver at
# module scope and exits without it, so a driver-free reader (a test) needs the numbers here.

# slow backend start ↔ hook stall; hung-postmaster worst case = 2 write connects + backoff + failure-record connect
CONNECT_TIMEOUT_SEC = 3
RETRY_BACKOFF_SEC = 0.5
# longest one hook write may stall the session on a hung database — far under the 600 s host default, as a hook runs on every event
HOOK_STALL_CEILING_SEC = 15
