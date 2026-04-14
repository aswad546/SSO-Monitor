import logging
import subprocess
import time
import json
import os
import re
import traceback

logger = logging.getLogger(__name__)

class Crawling:
    def __init__(self, config: dict, result: dict, domain):
        self.resolved_url = result["resolved"]["url"]
        self.domain = domain
        self.result = result
        pass
            
    # Screenshots are labelled page_1.png, page_4.png etc 
    # TODO: Replace with regex
    def extract_page_number(self, file_name):
        collect = ''
        for char in file_name:
            if char >= '0' and char <= '9':
                collect += char
        return int(collect)


    def read_action_file(self, actions_file_path):
        click_sequence = []
        with open(actions_file_path, 'r') as act:
            actions = json.load(act)
            for action in actions:
                if 'clickPosition' in action and action['clickPosition'] is not None:
                    click_sequence.append((action['clickPosition']['x'], action['clickPosition']['y']))
        return actions, click_sequence


    def find_minimum_path_to_login_urls_for_flow(self, files, actions, login_pages, click_sequence):
        for file in files:
            try:
                # TODO: Add regex here
                page_number = self.extract_page_number(file)
                relevant_action = actions[page_number]
                action_url = relevant_action['url']
                relevant_click_sequence = click_sequence[:page_number - 1]
                # One login url may only have one login page (across all flows), find shortest path (number of clicks) to reach this page
                if action_url not in login_pages or len(login_pages[action_url]) > len(relevant_click_sequence):
                    login_pages[action_url] = actions[:page_number]
            except Exception as e:
                print(f'Finding actions for the following file {dir}/{file} failed due to {e}')
                logger.exception(f'Failed to find minimum path to login for {action_url}')


    def process_actions(self, output_dir, raw_results_dir):
        login_pages = {}
        flows_exist = False
        for dir, _, files in os.walk(output_dir):
            if 'flow_' in dir:
                flows_exist = True
                url, flow = dir.split('/')[-2:]
                print(f'Checking flow: {flow}')
                # Preprocess and collect all clicks upto a potential login page for each flow
                actions_file_path = os.path.join(raw_results_dir, flow,  f'click_actions_{flow}.json')
                actions, click_sequence = self.read_action_file(actions_file_path)
                self.find_minimum_path_to_login_urls_for_flow(files, actions, login_pages, click_sequence)
        if flows_exist == False:
            logger.warn(f'No flows exist for {output_dir}')
        return login_pages



    def start(self):
        script_path = '/app/modules/loginpagedetection/crawler.js'
        args = [
            "node",
            script_path,
            self.domain,
        ]

        logger.info(f"Starting crawling login page detection for url: {self.domain}")

        # Run the subprocess
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,  # equivalent to universal_newlines=True
                bufsize=1   # line-buffered
            )
            
            # Read stdout and stderr line by line in real time.
            # Using iter() to continuously read lines until EOF.
            for line in iter(proc.stdout.readline, ''):
                logger.info(f"stdout: {line.strip()}")
            for line in iter(proc.stderr.readline, ''):
                logger.error(f"stderr: {line.strip()}")
            
            # Wait for the process to complete
            proc.wait()
            
            if proc.returncode != 0:
                raise subprocess.CalledProcessError(proc.returncode, args)
            
            logger.info("Puppeteer script executed successfully")
  
            logger.info('Finding valid urls')
            adjustedURL = self.domain.replace('.', '_')
            output_dir = f'/app/modules/loginpagedetection/output_images/{adjustedURL}'
            raw_results_dir = f'/app/modules/loginpagedetection/screenshot_flows/{adjustedURL}'
            login_pages = self.process_actions(output_dir, raw_results_dir)
            
            for url, actions in login_pages.items():
                self.result["login_page_candidates"].append({
                    'login_page_candidate': url,
                    'login_page_strategy': 'CRAWLING',
                    'login_page_actions': actions
                })
            logger.info(f'Completed crawling url: {self.domain}')
            
        except subprocess.CalledProcessError as e:
            logger.error("Error executing Puppeteer script")
            logger.error(f"Return code: {e.returncode}")
            raise
        except Exception as e:
            logger.exception(f"Error while crawling: {self.domain}")
            raise
