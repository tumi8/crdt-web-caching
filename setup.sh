#!/bin/bash

set -euxo pipefail

apt-get update

DEBIAN_FRONTEND=noninteractive apt-get install -y cgroup-tools cgroupfs-mount curl python3 python3-pip python3-venv redis sudo tmux telnet net-tools sysstat

cgroupfs-mount
cgget -n -g cpu -g cpuacct -g cpuset /

MININET_LOC=~/mininet
if [[ ! -d $MININET_LOC ]]; then
	(cd ~ && git clone https://gitlab+deploy-token-1700:gldt-zSLLAYxsr45EsbQfvYzr@gitlab.lrz.de/ms/ng-api/mininet.git)
	# (cd $MININET_LOC && git checkout -b mininet-2.3.1b4 2.3.1b4 )
fi

# installs nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

nvm install 22
# verifies the right Node.js version is in the environment
node -v # should print `v20.18.0`
# verifies the right npm version is in the environment
npm -v # should print `10.8.2`


#(cd $MININET_LOC && make mnexec)

npm install --global tsx@4.19.2 yarn@1.21.1

cd "$(dirname "$0")"

( cd origin-ts && yarn install )

( cd edge-cache-ts && yarn install)

(cd mininet && python3 -m venv .venv)
#mv $MININET_LOC/mnexec .venv/bin/
#(cd auto-client && python3 -m venv .venv && ./.venv/bin/pip3 install -r requirements.txt) 

source ./mininet/.venv/bin/activate
pip3 install -r ./mininet/requirements.txt

PYTHON=$(which python3) ~/mininet/util/install.sh -3a || true

