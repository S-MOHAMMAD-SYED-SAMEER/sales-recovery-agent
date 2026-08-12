# Chroma server for the sales-recovery-agent's RAG vector store, deployed as
# its own Render Web Service, separate from the main app. See
# ../DEPLOYMENT.md for the exact Render configuration (root directory, port,
# env vars) and how the main app's CHROMA_HOST/CHROMA_PORT must point here.
#
# This is the official Chroma image, unmodified — this file exists only so
# Render's "build from Dockerfile" flow has something in the repo to point
# at. It adds nothing on top of the upstream image; CMD/ENTRYPOINT are
# inherited as-is from chromadb/chroma, not reimplemented here.
FROM chromadb/chroma:latest

# Chroma's own Dockerfile sets CHROMA_HOST_ADDR=0.0.0.0 and
# CHROMA_HOST_PORT=8000 by default — it already binds all interfaces on the
# port Render needs to route to, and 8000 already matches the app's
# CHROMA_PORT default (server/src/config/env.js). No env var overrides
# needed here.
EXPOSE 8000
