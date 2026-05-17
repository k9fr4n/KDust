# ews-mcp-patched: thin wrapper over the upstream image to make it compatible
# with the Docker MCP gateway runtime constraints. Two patches:
#
# 1. Banner echo -> stderr. docker-entrypoint.sh writes
#    `[YYYY-MM-DDTHH:MM:SSZ] EWS-MCP v3.4 starting` on STDOUT before python
#    starts. The gateway parses stdout as JSON-RPC and chokes:
#    `invalid character '-' after array element`.
#
# 2. Drop `gosu mcp` indirection. The gateway runs every child container
#    with --security-opt no-new-privileges, which blocks gosu's setuid bit
#    (`error: failed switching to "mcp": operation not permitted`). We set
#    USER mcp at image level instead, so the container starts directly as
#    the unprivileged user without any setuid call at runtime.
#
# Build (host or Pi):
#   docker build -t ews-mcp-patched:local mcp-gateway/images/ews-mcp-patched
#
# The catalog entry references `ews-mcp-patched:local` and the gateway
# runs with `--pull never`, so the locally-built image is used as-is.
# Upstream fix tracked in: https://github.com/azizmazrou/ews-mcp/issues/new
FROM ghcr.io/azizmazrou/ews-mcp:latest
USER root
RUN sed -i 's|^echo "\[|echo >\&2 "[|' /usr/local/bin/docker-entrypoint.sh \
 && sed -i 's|^exec gosu mcp |exec |' /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/logs/analysis \
 && chown -R mcp:mcp /app/logs \
 && chmod -R 755 /app/logs
USER mcp
