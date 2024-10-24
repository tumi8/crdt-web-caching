#!/usr/bin/env python3
import itertools
import json
import logging
import multiprocessing
import os
import random
import signal
import subprocess
import sys
import time
from ipaddress import IPv4Address, IPv4Network, ip_network
from pathlib import Path
from typing import Iterator

import click
from mininet import util
from mininet.link import TCLink
from mininet.net import Mininet
from mininet.node import Node, Host, CPULimitedHost, OVSController, Controller
from mininet.topo import Topo
from mininet.topolib import TreeTopo
from mininet.util import errFail, quietRun, errRun

AUTO_CLIENT_BIN = Path('.') / 'auto-client' / 'main.py'
EDGE_SERVER_DIR = Path('.') / 'edge-cache-ts'
ORIGIN_SERVER_DIR = Path('.') / 'origin-ts'
random.seed(42)

if not AUTO_CLIENT_BIN.exists():
    raise FileNotFoundError(AUTO_CLIENT_BIN)


class OriginEdgeTopology(Topo):
    origin: str
    edge_servers: list[str]
    edge_links: list[str]
    num_clients: int
    client_edge_mapping: list[int]
    edge_server_ips: list[IPv4Address]
    edge_server_origin_ips: list[IPv4Address]
    edge_server_net_gen: list[Iterator[IPv4Address]]
    origin_edge_network: IPv4Network
    origin_process: subprocess.Popen
    client_processes: list[subprocess.Popen]
    edge_processes: list[subprocess.Popen]

    def __init__(self, num_clients=5, *args, **params):
        self.num_clients = num_clients
        self.num_cores = multiprocessing.cpu_count()
        self.edge_servers = []
        self.edge_processes = []
        self.client_processes = []
        super().__init__(*args, **params)

    def re_model(self, x) -> str:
        rtt = 10.89 + 0.02 * x
        return f'{rtt / 2:.2f}ms'

    def build(self):
        "Create custom topo."
        self.origin_edge_network = ip_network('10.0.0.0/16')
        origin_edge_network_hosts = self.origin_edge_network.hosts()

        self.origin = self.addHost('origin', cores=2, ip=f'{next(origin_edge_network_hosts)}/16')
        self.origin_edge_switch = self.addSwitch('s0')
        self.addLink(self.origin, self.origin_edge_switch)

        self.edge_server_origin_ips = [next(origin_edge_network_hosts) for _ in range(5)]
        current_core = 3
        for i, ip in enumerate(self.edge_server_origin_ips):
            self.edge_servers.append(self.addHost(f'e{i + 1}', cores=[current_core, current_core+1], ip=f'{ip}/16'))
            current_core += 2

        # Origin to Edge Server Links
        for edge_server, edge_ip, edge_distance in zip(self.edge_servers, self.edge_server_origin_ips, [0, 1000, 1000, 1000, 1000]):
            link_delay = self.re_model(edge_distance)
            self.addLink(self.origin_edge_switch, edge_server, delay=link_delay, params2={'ip': f'{edge_ip}/16'}, cls=TCLink)

        self.edge_client_switches = [self.addSwitch(f's{i + 1}') for i in range(5)]

        self.edge_server_net_gen = [ip_network(f'10.{i + 1}.0.0/16').hosts() for i in range(5)]
        self.edge_server_ips = [next(net_gen) for net_gen in self.edge_server_net_gen]

        for edge_server, edge_ip, edge_switch in zip(self.edge_servers, self.edge_server_ips, self.edge_client_switches):
            self.addLink(edge_switch, edge_server, params2={'ip': f'{edge_ip}/16'})

        self.client_edge_mapping = [ i % len(self.edge_servers) for i in range(self.num_clients)]

        client_cores_cycle = itertools.cycle(list(range(current_core, self.num_cores)))

        for i, client_edge_mapping in enumerate(self.client_edge_mapping):
            km_distance = random.randint(50, 500)
            client_delay = self.re_model(km_distance)

            new_client = self.addHost(f'x{i}', cores=next(client_cores_cycle), ip=f'{next(self.edge_server_net_gen[client_edge_mapping])}/16')
            self.addLink(new_client, self.edge_client_switches[client_edge_mapping], delay=client_delay, cls=TCLink)

    def start(self, net: Mininet, log_dir: Path):
        edge_servers: list[Node] = [net.get(edge_server) for edge_server in self.edge_servers]

        origin_host = net.get(self.origin)
        origin_ip = origin_host.IP()

        sub_env = os.environ.copy()
        sub_env['PORT'] = '3000'
        origin_log = (log_dir / 'origin.log').open(mode='w')
        origin_err_log = (log_dir / 'origin.err.log').open(mode='w')
        self.origin_process = origin_host.popen(['src/index.ts'], cwd=ORIGIN_SERVER_DIR, env=sub_env, stdout=origin_log, stderr=origin_err_log)
        time.sleep(2)

        for i, edge_server in enumerate(edge_servers):
            sub_env = os.environ.copy()
            sub_env['HOST_NAME'] = f'{self.edge_server_origin_ips[i]}'
            sub_env['EDGE_SERVERS'] = ','.join([f'{ip}:{8005}' for ip in self.edge_server_origin_ips])
            sub_env['ORIGIN'] = f'{origin_ip}:3000'
            sub_env['PORT'] = f'8005'
            sub_env['REDIS_PORT'] = f'8006'
            edge_server_log = (log_dir / f"edge_server_{i}.log").open(mode='w')
            edge_server_err_log = (log_dir / f"edge_server_{i}.err.log").open(mode='w')
            self.edge_processes.append(edge_server.popen(['src/index.ts'], cwd=EDGE_SERVER_DIR, env=sub_env, stderr=edge_server_err_log, stdout=edge_server_log))

    def start_client(self, net: Mininet, num_of_client: int, api: str, mode: str, log_dir: Path):
        edge_server_ip = self.edge_server_ips[self.client_edge_mapping[num_of_client]]

        client_log = (log_dir / f"client_{num_of_client}.log").open(mode='w')
        client_err_log = (log_dir / f"client_{num_of_client}.err.log").open(mode='w')

        client_node = net.get(f'x{num_of_client}')

        self.client_processes.append(client_node.popen([f'{AUTO_CLIENT_BIN}', '--api', api, '--mode', mode, '--edge-server', f'{edge_server_ip}:8005', '--client-number', f'{num_of_client}'], stdout=client_log, stderr=client_err_log))

    def stop(self):
        for client_process in self.client_processes:
            client_process.send_signal(signal.SIGINT)

        for client_process in self.client_processes:
            self.wait_process(client_process)

        for edge_process in self.edge_processes:
            edge_process.send_signal(signal.SIGINT)

        for edge_process in self.edge_processes:
            self.wait_process(edge_process)

        self.origin_process.send_signal(signal.SIGINT)
        self.origin_process.wait()

    def wait_process(self, p: subprocess.Popen):
        try:
            p.wait(30)
        except subprocess.TimeoutExpired as e:
            logging.error(f'Timeout while waiting for process: {e}')

@click.command()
@click.option('--api', type=click.Choice(['flights', 'forums']), required=True)
@click.option('--mode', type=click.Choice(['proxy', 'cache', 'ttl', 'crdt']), required=True)
@click.option('--scale-interval', type=click.IntRange(min=0), default=5)
@click.option('--scale-size', type=click.IntRange(min=1), default=1)
@click.option('--scale-times', type=click.IntRange(min=1), default=500)
@click.option('--log-dir', type=click.Path(file_okay=False, dir_okay=True), required=True)
def main(api: str, mode: str, scale_interval: int, scale_size: int, scale_times: int, log_dir: Path):
    log_dir = Path(log_dir)
    log_dir.mkdir(exist_ok=True, parents=True)

    logging.basicConfig(level=logging.INFO, handlers=[logging.StreamHandler(), logging.FileHandler(log_dir / 'mininet.log', errors='backslashreplace')])

    logging.info(f'Running api {api} in mode {mode} with interval {scale_interval} and size {scale_size} times {scale_times}')

    maximum_clients = scale_times * scale_size

    topo = OriginEdgeTopology(num_clients=maximum_clients)

    logging.info(f'Creating Mininet Topology')
    net = Mininet(topo=topo, autoPinCpus=False, host=CPULimitedHost, cleanup=True)
    logging.info(f'Starting Mininet')

    try:
        net.start()

        logging.info(f'Starting Origin and Edge Servers')
        topo.start(net, log_dir)
        time.sleep(1)

        ploss = net.ping([net.get(h) for h in ['origin', 'e1', 'e2', 'e3', 'e4', 'e5']], timeout='300ms')
        if ploss > 99.0:
            logging.critical(f'No connectivity between nodes (ploss: {ploss})')
            sys.exit(1)

        net.pingFull([net.get(h) for h in ['origin', 'e1', 'e2']],  timeout='300ms')

        current_active_hosts = 0
        logging.info(json.dumps({'type': 'Update', 'time': time.time_ns(), 'active_clients': current_active_hosts}))
        while current_active_hosts < scale_times * scale_size:
            logging.info(f'Scaling up clients from {current_active_hosts} to {current_active_hosts + scale_size}')
            for hi in range(scale_size):
                topo.start_client(net, current_active_hosts, api, mode, log_dir)
                current_active_hosts += 1
                logging.info(json.dumps({ 'type': 'Update', 'time': time.time_ns(), 'active_clients': current_active_hosts }))
            time.sleep(scale_interval)

        topo.stop()
        logging.info(json.dumps({'type': 'Update', 'time': time.time_ns(), 'active_clients': current_active_hosts+1}))

    finally:
        net.stop()


topos = {'oetopo': (lambda: OriginEdgeTopology())}

# Press the green button in the gutter to run the script.
if __name__ == '__main__':
    main()

# See PyCharm help at https://www.jetbrains.com/help/pycharm/
