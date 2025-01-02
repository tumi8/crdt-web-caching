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
from threading import Thread
from typing import Iterator, Iterable, Tuple

import click
import psutil
from mininet.link import TCLink
from mininet.net import Mininet
from mininet.node import Node, CPULimitedHost
from mininet.topo import Topo
from psutil import Process

AUTO_CLIENT_BIN = Path('.') / 'auto-client' / 'main.py'
EDGE_SERVER_DIR = Path('.') / 'edge-cache-ts'
ORIGIN_SERVER_DIR = Path('.') / 'origin-ts'
random.seed(42)
PROCESS_START_TIME = time.time_ns()
logging_active = True
OBSERVED_PROCESSES: list[Tuple[str, Process]] = []

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
    origin_processes: list[subprocess.Popen]
    client_processes: list[subprocess.Popen]
    edge_processes: list[subprocess.Popen]

    def __init__(self, num_clients=5, *args, **params):
        self.num_clients = num_clients
        self.num_cores = multiprocessing.cpu_count()
        self.edge_servers = []
        self.edge_processes = []
        self.origin_processes = []
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

    def start(self, net: Mininet, log_dir: Path, stats: bool):
        edge_servers: list[Node] = [net.get(edge_server) for edge_server in self.edge_servers]

        origin_host = net.get(self.origin)
        origin_ip = origin_host.IP()

        sub_env = os.environ.copy()
        sub_env['PORT'] = '3000'
        origin_log = (log_dir / 'origin.log').open(mode='w')
        origin_err_log = (log_dir / 'origin.err.log').open(mode='w')
        origin_process = origin_host.popen(['src/index.ts'], cwd=ORIGIN_SERVER_DIR, env=sub_env, stdout=origin_log, stderr=origin_err_log)
        self.origin_processes.append(origin_process)
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
            edge_server_process = edge_server.popen(['src/index.ts'], cwd=EDGE_SERVER_DIR, env=sub_env, stderr=edge_server_err_log, stdout=edge_server_log)
            self.edge_processes.append(edge_server_process)
            if stats:
                self.start_stat_recording(edge_server, edge_server_process.pid, log_dir, f"edge_server_{i}", self.edge_processes)

        if stats:
            self.start_stat_recording(origin_host, origin_process.pid, log_dir, f"origin", self.origin_processes)

    def start_client(self, net: Mininet, num_of_client: int, api: str, mode: str, log_dir: Path, stats: bool):
        edge_server_ip = self.edge_server_ips[self.client_edge_mapping[num_of_client]]

        client_log = (log_dir / f"client_{num_of_client}.log").open(mode='w')
        client_err_log = (log_dir / f"client_{num_of_client}.err.log").open(mode='w')

        client_node: CPULimitedHost = net.get(f'x{num_of_client}')

        client_process = client_node.popen([f'{AUTO_CLIENT_BIN}', '--api', api, '--mode', mode, '--edge-server', f'{edge_server_ip}:8005', '--client-number', f'{num_of_client}'], env=os.environ.copy(), stdout=client_log, stderr=client_err_log)
        if stats:
            self.start_stat_recording(client_node, client_process.pid, log_dir, f"client_{num_of_client}", self.client_processes)


        self.client_processes.append(client_process)

    def start_stat_recording(self, node: Node, pid: int, log_dir:Path, file_name: str, add_to_list: list):
        logging.info(json.dumps({'type': 'Stats', 'time': time.time_ns(), 'file': f"{file_name}_stats", "pid": pid}))
        # global OBSERVED_PROCESSES
        # OBSERVED_PROCESSES.append(( file_name, psutil.Process(pid)))

        # stat_cpu_log = log_dir / f"{file_name}.cpu"
        # stat_mem_log = log_dir / f"{file_name}.mem"
        stat_log = log_dir / f"{file_name}_stats.log"
        stat_err_log = (log_dir / f"{file_name}_stats.err.log").open(mode='w')
        stat_process = node.popen(['psrecord', f'{pid}', '--log', f'{stat_log.absolute()}', '--interval', '1', '--log-format', 'csv', '--include-children', '--include-io'], stdout=stat_err_log, stderr=stat_err_log, env=os.environ.copy())
        add_to_list.append(stat_process)
        #
        # yield subprocess.Popen(f'pidstat -p {pid} -I 1 -u > {stat_cpu_log.absolute()}.log 2> {stat_cpu_log.absolute()}.err.log', shell=True)
        # yield subprocess.Popen(f'pidstat -p {pid} -I 1 -r > {stat_mem_log.absolute()}.log 2> {stat_mem_log.absolute()}.err.log', shell=True)


    def stop(self):
        for client_process in self.client_processes:
            client_process.send_signal(signal.SIGINT)

        for client_process in self.client_processes:
            self.wait_process(client_process)

        for edge_process in self.edge_processes:
            edge_process.send_signal(signal.SIGINT)

        for edge_process in self.edge_processes:
            self.wait_process(edge_process)

        for origin_process in self.origin_processes:
            origin_process.send_signal(signal.SIGINT)
            origin_process.wait()


    def wait_process(self, p: subprocess.Popen):
        try:
            p.wait(30)
        except subprocess.TimeoutExpired as e:
            logging.error(f'Timeout while waiting for process: {e}')


def get_all_children(pr) -> list[Process]:
    try:
        return pr.children(recursive=True)
    except Exception as e:
        logging.error(f'Could not get process children', exc_info=e)
        return []

def logging_thread(log_dir: Path):
    with (log_dir / 'interface_stats.log').open(mode='w') as log_file:
        while logging_active:
            # Interface Statistics
            net_stats: dict = psutil.net_io_counters(pernic=True)
            log_file.write(json.dumps({'type': 'Interfaces', 'time': time.time_ns(), 'stats': net_stats}) + os.linesep)

            # Process Stats
            # for obs_name, pr in OBSERVED_PROCESSES:
            #     try:
            #         pr_status = pr.status()
            #     except psutil.NoSuchProcess:
            #         logging.error(f'Process {pr} did not exist')
            #         continue
            #     if pr_status in [psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD]:
            #         print(f"Process {pr} finished seconds)")
            #         continue
            #
            #     try:
            #         current_cpu = pr.cpu_percent()
            #         current_mem = pr.memory_info()
            #         mem_percent_real = pr.memory_percent(memtype="rss")
            #         mem_percent_virt = pr.memory_percent(memtype="vms")
            #     except Exception as e:
            #         logging.error(f'Error retrieving process stats', exc_info=e)
            #         continue
            #     current_mem_real = current_mem.rss / 1024.0 ** 2
            #     current_mem_virtual = current_mem.vms / 1024.0 ** 2
            #     n_proc = 1
            #
            #     # Get information for children
            #
            #     for child in get_all_children(pr):
            #         try:
            #             current_cpu += child.cpu_percent()
            #             current_mem = child.memory_info()
            #             current_mem_real += current_mem.rss / 1024.0 ** 2
            #             current_mem_virtual += current_mem.vms / 1024.0 ** 2
            #             mem_percent_real += child.memory_percent(memtype="rss")
            #             mem_percent_virt += child.memory_percent(memtype="vms")
            #             n_proc += 1
            #         except Exception as e:
            #             logging.error(f'Error retrieving process stats', exc_info=e)
            #             continue
            #
            #     log_file.write(json.dumps({'type': 'Process', 'name': obs_name, 'n_proc': n_proc, 'time': time.time_ns(), 'pid': pr.pid, 'cpu_per_core': current_cpu, 'mem_real': current_mem_real, 'mem_virtual': current_mem_virtual,
            #                                'mem_real_perc': mem_percent_real, 'mem_virtual_perc': mem_percent_virt}) + os.linesep)

            time.sleep(1)


@click.command()
@click.option('--api', type=click.Choice(['flights', 'forums']), required=True)
@click.option('--mode', type=click.Choice(['proxy', 'cache', 'ttl', 'crdt']), required=True)
@click.option('--scale-interval', type=click.IntRange(min=0), default=5)
@click.option('--scale-size', type=click.IntRange(min=1), default=1)
@click.option('--scale-times', type=click.IntRange(min=1), default=500)
@click.option('--log-dir', type=click.Path(file_okay=False, dir_okay=True), required=True)
@click.option('--stats', type=bool, default=False)
def main(api: str, mode: str, scale_interval: int, scale_size: int, scale_times: int, log_dir: Path, stats: bool):
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

        if stats:
            interface_logging_thread = Thread(target=logging_thread, args=[log_dir])
            interface_logging_thread.start()


        logging.info(f'Starting Origin and Edge Servers')
        topo.start(net, log_dir, stats)
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
                topo.start_client(net, current_active_hosts, api, mode, log_dir, stats)
                current_active_hosts += 1
                logging.info(json.dumps({ 'type': 'Update', 'time': time.time_ns(), 'active_clients': current_active_hosts }))
            time.sleep(scale_interval)

        global logging_active
        logging_active = False

        topo.stop()
        logging.info(json.dumps({'type': 'Update', 'time': time.time_ns(), 'active_clients': current_active_hosts+1}))
        time.sleep(1)


    finally:
        net.stop()


topos = {'oetopo': (lambda: OriginEdgeTopology())}

# Press the green button in the gutter to run the script.
if __name__ == '__main__':
    main()

# See PyCharm help at https://www.jetbrains.com/help/pycharm/
