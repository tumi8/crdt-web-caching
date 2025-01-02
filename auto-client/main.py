#!/usr/bin/env python3

import json
import logging
import random
import select
import signal
import string
import sys
import time
from json import JSONDecodeError
from typing import Dict

import click
import requests
import validators
import numpy as np
from requests import Response

interrupted = False
random.seed(42)


def signal_handler(sig, frame):
    print('Interrupt received!', file=sys.stderr, flush=True)
    global interrupted
    interrupted = True

@click.command()
@click.option('--api', type=click.Choice(['flights', 'forums']), required=True)
@click.option('--mode', type=click.Choice(['proxy', 'cache', 'ttl', 'crdt']), required=True)
@click.option('--edge-server', type=str, required=True)
@click.option('--client-number', default=1, type=click.IntRange(min=0), required=False)
@click.option('--test', type=click.IntRange(min=0), required=False)
def main(api: str, mode: str, edge_server: str, test: int, client_number: int):
    signal.signal(signal.SIGINT, signal_handler)
    run_autonomous_client(api, mode, edge_server, test, client_number)


def run_flights_client(edge_server_url: str, headers: dict, runs: int):
    start_time = time.time_ns()
    last_query_time = start_time

    try:
        # 1 Get flights
        flightsRequest = requests.get(f'{edge_server_url}/flights', headers=headers)
        flights = flightsRequest.json()
        if not flightsRequest.ok:
            log_event('Inconsistent', f'Outdated information {flights}', last_query_time, start_time, object='flights')
            return

        log_version(flights["meta"], flightsRequest, last_query_time)

        if type(flights["data"]) is dict:
            flight_list = list(flights['data'].values())
            my_flight_choice = flight_list[make_flight_choice()]
        else:
            my_flight_choice = flights['data'][make_flight_choice()]

        # Get concrete flight plan
        last_query_time = time.time_ns()
        flightDetailsUrl = f'{edge_server_url}/flights/{my_flight_choice["number"]}'
        flightDetailRequest = requests.get(flightDetailsUrl, headers=headers)
        flightDetails = flightDetailRequest.json()
        if not flightDetailRequest.ok:
            log_event('Inconsistent', f'Outdated information {flightDetails}', last_query_time, start_time,
                      object=f'flight_{my_flight_choice["number"]}')
            return

        log_version(flightDetails["meta"], flightDetailRequest, last_query_time)

        # Select a seat
        available_seats = [seat['number'] for seat in flightDetails['data']['seatingPlan'].values() if not seat['booked']]

        if len(available_seats) == 0:
            log_event('Conflict', f'seatPlan empty', last_query_time, start_time)
            return

        chosen_seat = random.choice(available_seats)

        # Book the seat
        last_query_time = time.time_ns()
        result = requests.post(f'{flightDetailsUrl}/book/{chosen_seat}', headers=headers)
        resultJson = result.json()
        if result.ok:
            log_event('Success', f'booked seat {chosen_seat} {resultJson["success"]}', last_query_time, start_time)
        elif result.status_code == 404:
            log_event('Inconsistent', f'Outdated information {flightDetails}', last_query_time, start_time,
                      object=f'flight_{my_flight_choice["number"]}')
        else:
            log_event('Conflict', f'Error booking seat {chosen_seat}: {resultJson}', last_query_time, start_time)

    except JSONDecodeError as e:
        logging.error(f'Coudl not decode JSON: {e.msg}, {e.doc}, {e.pos}', exc_info=e)
        log_event('Failure', f'json decode {e}', last_query_time, start_time)
    except Exception as e:
        logging.error(f'Exception occurred: {e}', exc_info=e)
        log_event('Failure', f'error {e}', last_query_time, start_time)
        time.sleep(0.01 + random.random())


def run_forum_client(edge_server_url: str, headers: dict, runs: int):
    start_time = time.time_ns()
    last_query_time = start_time
    try:
        # 1 Get all Forums
        forumRequest = requests.get(f'{edge_server_url}/forums', headers=headers)
        forums = forumRequest.json()
        if not forumRequest.ok:
            log_event('Inconsistent', f'Outdated information {forums["errors"]}', last_query_time, start_time, object='forums')
            return

        log_version(forums["meta"], forumRequest, last_query_time)

        my_forum_int_choice = random.randint(0, 99)
        if type(forums["data"]) is dict:
            forum_list = list(forums['data'].values())
            my_forum_choice = forum_list[my_forum_int_choice]
        else:
            my_forum_choice = forums['data'][my_forum_int_choice]

        # Get concrete forum
        last_query_time = time.time_ns()
        forumDetailsUrl = f'{edge_server_url}/forums/{my_forum_choice["id"]}'
        forumDetailRequest = requests.get(forumDetailsUrl, headers=headers)
        forumDetails = forumDetailRequest.json()
        if not forumDetailRequest.ok:
            log_event('Failure', f'Not found {forumDetails["errors"]}', last_query_time, start_time,
                      object=f'forum_{my_forum_int_choice}')
            return

        log_version(forumDetails["meta"], forumDetailRequest, last_query_time)

        # Post a message
        post = runs % 5 == 0
        if post:
            forumPost = ''.join(random.choices(string.ascii_lowercase, k=25))
            result = requests.post(forumDetailsUrl, headers=headers, json={ 'message': forumPost })
            resultJson = result.json()
            if result.ok:
                log_event('Success', f'posted message', last_query_time, start_time)
            else:
                log_event('Failure', f'Error {resultJson}', last_query_time, start_time,
                          object=f'forum_{my_forum_int_choice}')

    except JSONDecodeError as e:
        logging.error(f'Coudl not decode JSON: {e.msg}, {e.doc}, {e.pos}', exc_info=e)
        log_event('Failure', f'json decode {e}', last_query_time, start_time)
    except Exception as e:
        logging.error(f'Exception occurred: {e}', exc_info=e)
        log_event('Failure', f'error {e}', last_query_time, start_time)
        time.sleep(0.01 + random.random())
        # time.sleep(5)


def run_autonomous_client(api: str, mode: str, edge_server: str, test: int, client_number: int):
    logging.basicConfig(level=logging.INFO)
    logging.info(f'Starting Auto-Client {client_number} on API {api} with mode {mode}. Connecting to {edge_server}.')
    headers = None
    if mode == 'ttl':
        headers = { 'no-invalidation': 'True' }
        mode = 'cache'

    edge_server_url = f'http://{edge_server}/{mode}'
    validators.url(edge_server_url)
    n = 0
    global interrupted
    while not interrupted:
        if test is not None:
            if n >= test:
                break
        n += 1

        if select.select([sys.stdin, ], [], [], 0.0)[0]:
            readline = sys.stdin.readline().strip()
            if 'CLOSE' in readline:
                print('Received CLOSE input', file=sys.stderr, flush=True)
                interrupted = True

        if api == 'flights':
            run_flights_client(edge_server_url, headers, n)
        elif api == 'forums':
            run_forum_client(edge_server_url, headers, n)

def log_event(event: str, details: str, start_time: int, total_start_time: int, object: str = None):
    curr_time = time.time_ns()
    duration = curr_time - start_time
    total_duration = curr_time - total_start_time
    log_msg = {'type': event, 'event': details, 'time': time.time_ns(), 'duration': duration, 'total_duration': total_duration}
    if object is not None:
        log_msg['object'] = object
    print(json.dumps(log_msg))


def log_version(meta: Dict, response: Response, start_time: int):
    try:
        cached = None
        cachedHeader = response.headers.get('X-Cached')
        if cachedHeader:
            cached = cachedHeader == 'true'
        duration = time.time_ns() - start_time
        log_msg = { 'type': 'Versioning', 'time': time.time_ns(), 'object': meta['id'], 'version': meta['version'], 'duration': duration, 'cached': cached }
        print(json.dumps(log_msg))
    except Exception as err:
        logging.exception(f'Exception during logging version {err}', exc_info=err)
        raise err


def make_flight_choice() -> int:
    s = -1
    mu, sigma = 20, 30
    while s < 0 or s >= 100:
        s = int(np.random.normal(mu, sigma))
    return s


if __name__ == '__main__':
    main()
