# The Linux image scripts/ci-container.sh runs btrain's CI in. Starts from
# btrain-git255 (Ubuntu 24.04, Node 22, git 2.55, the git that exposed the
# auto-maintenance teardown race) and adds the two tools the hosted runner has
# that the base image lacks: jq, which .claude/scripts/unblocked-context.sh
# needs, python3-venv for the Python test step, and ast-grep 0.45.3 (spec 020's pin), which the decomposition
# inventory runs. ast-grep comes from npm rather than a release zip so the
# build needs no curl and works on arm64 and x86_64 alike.
FROM btrain-git255:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq jq python3-venv python3-pip >/dev/null && rm -rf /var/lib/apt/lists/* \
  && npm install -g --prefix /opt/ast-grep --no-fund --no-audit @ast-grep/cli@0.45.3 >/dev/null \
  && ln -s /opt/ast-grep/bin/ast-grep /usr/local/bin/ast-grep \
  && ast-grep --version && jq --version
# The package also ships `sg`, which would collide with Ubuntu's /usr/bin/sg
# (newgrp); the private prefix keeps that one out of PATH.
