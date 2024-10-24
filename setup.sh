#!/bin/bash

set -euxo pipefail

apt-get update

DEBIAN_FRONTEND=noninteractive apt-get install -y cgroup-tools cgroupfs-mount curl python3 python3-pip python3-venv nodejs npm redis sudo python3-validators python3-click python3-requests python3-numpy tmux telnet net-tools

cgroupfs-mount
cgget -n -g cpu -g cpuacct -g cpuset /

MININET_LOC=~/mininet
if [[ ! -d $MININET_LOC ]]; then
	(cd ~ && git clone git@github.com:mininet/mininet.git)
	# (cd $MININET_LOC && git checkout -b mininet-2.3.1b4 2.3.1b4 )
fi

#(cd $MININET_LOC && make mnexec)

npm install --global yarn tsx

cd "$(dirname "$0")"

( cd origin-ts && yarn install )

( cd edge-cache-ts && yarn install)

(cd mininet && python3 -m venv .venv --system-site-packages)
#mv $MININET_LOC/mnexec .venv/bin/
#(cd auto-client && python3 -m venv .venv && ./.venv/bin/pip3 install -r requirements.txt) 

source ./mininet/.venv/bin/activate
#pip3 install -r ./mininet/requirements.txt

PYTHON=$(which python3) ~/mininet/util/install.sh -3a || true

