#!/bin/bash
# Future qualified-container compiler role only; no native network probe runs here.
set -euo pipefail
/tools/bin/node --version
/tools/bin/node /tools/lib/node_modules/npm/bin/npm-cli.js --version
/usr/bin/gcc -std=c11 -O2 -Wall -Wextra -Werror /harness/net-denial-oracle-fixtures.c -o /work/probe/net-denial-oracle-fixtures
/work/probe/net-denial-oracle-fixtures
/usr/bin/gcc -std=c11 -O2 -Wall -Wextra -Werror /harness/native-probe.c -o /work/probe/native-probe
