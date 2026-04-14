const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net = require('net');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Import OpenTelemetry
const { sdk } = require('./otel-setup');
const { trace, metrics, context } = require('@opentelemetry/api');

// Global variable to hold the URL for the current crawl
let currentCrawlUrl = "unknown";

// --- New Structured Logging Functions ---
function getTraceContext() {
  const span = trace.getSpan(context.active());
  const ctx = span ? span.spanContext() : {};
  return {
    trace_id: ctx.traceId || "",
    span_id: ctx.spanId || ""
  };
}

function logInfo(message, url = currentCrawlUrl) {
  console.log(JSON.stringify({
    system: 'login-crawler',
    timestamp: new Date().toISOString(),
    level: 'info',
    url,
    message,
    ...getTraceContext()
  }));
}

function logWarn(message, url = currentCrawlUrl) {
  console.warn(JSON.stringify({
    system: 'login-crawler',
    timestamp: new Date().toISOString(),
    level: 'warn',
    url,
    message,
    ...getTraceContext()
  }));
}

function logError(message, url = currentCrawlUrl, error) {
  console.error(JSON.stringify({
    system: 'login-crawler',
    timestamp: new Date().toISOString(),
    level: 'error',
    url,
    message,
    error: error ? error.message : "",
    ...getTraceContext()
  }));
}
// --- End Logging Functions ---

// Create tracer and meters
const tracer = trace.getTracer('crawler-tracer');
const meter = metrics.getMeter('crawler-metrics');

// Create metrics
const pageLoadHistogram = meter.createHistogram('page_load_duration', {
  description: 'Duration of page loads in milliseconds',
  unit: 'ms',
});

const screenshotClassificationHistogram = meter.createHistogram('screenshot_classification_duration', {
  description: 'Duration of screenshot classification in milliseconds',
  unit: 'ms',
});

const clickPositionRetrievalHistogram = meter.createHistogram('click_position_retrieval_duration', {
  description: 'Duration of retrieving click positions in milliseconds',
  unit: 'ms',
});

const flowDurationHistogram = meter.createHistogram('flow_duration', {
  description: 'Duration of a complete flow in milliseconds',
  unit: 'ms',
});

const crawlDurationHistogram = meter.createHistogram('total_crawl_duration', {
  description: 'Duration of the entire crawl in milliseconds',
  unit: 'ms',
});

const clickCounter = meter.createCounter('total_clicks', {
  description: 'Total number of clicks performed',
});

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// await page.evaluateOnNewDocument(() => {
//   delete navigator.__proto__.webdriver;
// });

// Function to generate a valid directory name based on the URL
function generateParentDirectoryName(url) {
  return `${url.replace(/https?:\/\//, '').replace(/\./g, '_')}`;
}

// Function to generate a valid directory name based on the flow index
function generateFlowDirectoryName(flowIndex) {
  return `flow_${flowIndex}`;
}

// Function to generate a valid file name based on the page sequence
function generateFileName(index) {
  return `page_${index}.png`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function overlayClickPosition(inputImagePath, outputImagePath, x, y) {
  return tracer.startActiveSpan('overlayClickPosition', async (span) => {
    const marker = Buffer.from(`
      <svg width="20" height="20">
        <circle cx="10" cy="10" r="10" fill="red" />
      </svg>
    `);

    try {
      span.setAttribute('input_path', inputImagePath);
      span.setAttribute('output_path', outputImagePath);
      span.setAttribute('click_x', x);
      span.setAttribute('click_y', y);
      
      const tempImagePath = outputImagePath + '_temp.png';

      await sharp(inputImagePath)
        .composite([{ input: marker, left: x - 10, top: y - 10 }])
        .toFile(tempImagePath);

      fs.renameSync(tempImagePath, outputImagePath);
      logInfo(`Updated screenshot saved with click overlay at: ${outputImagePath}`);
      
      span.setAttribute('success', true);
    } catch (error) {
      logError('Error overlaying click position on screenshot', currentCrawlUrl, error);
      span.recordException(error);
      span.setAttribute('success', false);
    } finally {
      span.end();
    }
  });
}

async function classifyScreenshot(screenshotPath) {
  return tracer.startActiveSpan('classifyScreenshot', async (span) => {
    span.setAttribute('screenshot_path', screenshotPath);
    const startTime = Date.now();
    let socket = null;
    
    try {
      const result = await new Promise((resolve, reject) => {
        const classificationHost = process.env.CLASSIFICATION_HOST || '172.17.0.1';
        const classificationPort = parseInt(process.env.CLASSIFICATION_PORT || '5060');
        
        socket = new net.Socket();
        
        // Add handler to receive the response data
        socket.on('data', (data) => {
          const response = data.toString().trim();
          logInfo(`Received classification response for ${screenshotPath}: ${response}`);
          span.setAttribute('classification_result', response);
          
          // Close the socket now that we have the response
          socket.end();
          
          // Resolve with the actual response
          resolve(response);
        });
        
        socket.on('error', (err) => {
          logError(`Socket error while classifying ${screenshotPath}`, currentCrawlUrl, err);
          span.recordException(err);
          reject(err);
        });
        
        // Add timeout to prevent hanging indefinitely
        socket.setTimeout(120000, () => {
          logWarn(`Classification timeout for ${screenshotPath}`);
          span.setAttribute('timeout', true);
          socket.destroy();
          reject(new Error("Classification request timed out"));
        });
        
        socket.connect(classificationPort, classificationHost, () => {
          logInfo(`Connected to classification server for ${screenshotPath}`);
          // Just send the path, but don't end the connection - wait for response
          socket.write(`${screenshotPath}\n`);
        });
      });
      
      const duration = Date.now() - startTime;
      screenshotClassificationHistogram.record(duration);
      span.setAttribute('duration_ms', duration);
      
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      // Ensure socket is properly closed if still open
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
      span.end();
    }
  });
}

// Function to get all select elements and their options
async function getSelectOptions(page) {
  return tracer.startActiveSpan('getSelectOptions', async (span) => {
    try {
      const selectElements = await page.$$('select');
      const allSelectOptions = [];

      for (let select of selectElements) {
        const options = await select.evaluate((select) => {
          return Array.from(select.options).map((option) => option.value);
        });
        allSelectOptions.push(options);
      }

      span.setAttribute('select_count', selectElements.length);
      span.setAttribute('option_count', allSelectOptions.reduce((sum, opts) => sum + opts.length, 0));
      return allSelectOptions;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// (Optional) Original function to generate full combinations – not used in the new flow generation logic
function generateOptionCombinations(optionsArray) {
  return tracer.startActiveSpan('generateOptionCombinations', (span) => {
    try {
      const combinations = [];

      const helper = (currentCombination, depth) => {
        if (depth === optionsArray.length) {
          combinations.push([...currentCombination]);
          return;
        }
        for (let option of optionsArray[depth]) {
          currentCombination.push(option);
          helper(currentCombination, depth + 1);
          currentCombination.pop();
        }
      };

      helper([], 0);
      
      span.setAttribute('combination_count', combinations.length);
      return combinations;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// Helper: Deduplicate select options and build a mapping.
function deduplicateOptionsWithMapping(optionsArray) {
  return tracer.startActiveSpan('deduplicateOptionsWithMapping', (span) => {
    try {
      const uniqueOptions = [];
      const mapping = [];
      const seenKeys = new Map();

      optionsArray.forEach((opts, idx) => {
        const key = JSON.stringify(opts);
        if (seenKeys.has(key)) {
          const uniqueIndex = seenKeys.get(key);
          mapping[uniqueIndex].push(idx);
        } else {
          seenKeys.set(key, uniqueOptions.length);
          uniqueOptions.push(opts);
          mapping.push([idx]);
        }
      });
      
      span.setAttribute('unique_option_groups', uniqueOptions.length);
      span.setAttribute('total_options', optionsArray.length);
      
      return { uniqueOptions, mapping };
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

async function fillInputFields(page) {
  return tracer.startActiveSpan('fillInputFields', async (span) => {
    try {
      const inputElements = await page.$$('input');
      let filledCount = 0;

      for (let input of inputElements) {
        try {
          await input.evaluate((element) => element.scrollIntoView());
          await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling

          const isVisible = await input.evaluate((element) => {
            const style = window.getComputedStyle(element);
            return style && style.visibility !== 'hidden' && style.display !== 'none';
          });

          const isReadOnly = await input.evaluate((element) => element.hasAttribute('readonly'));
          const isDisabled = await input.evaluate((element) => element.hasAttribute('disabled'));

          if (isVisible && !isReadOnly && !isDisabled) {
            await Promise.race([
              input.type('aa', { delay: 100 }),
              new Promise((_, reject) => setTimeout(() => reject('Timeout'), 3000)),
            ]);
            filledCount++;
          }
        } catch (e) {
          // Skipping non-interactable input field.
        }
      }

      await page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling to top
      await sleep(1000);
      
      span.setAttribute('total_input_elements', inputElements.length);
      span.setAttribute('filled_input_elements', filledCount);
      
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

async function detectNavigationOrNewTab(page) {
  let timeoutId = null;
  let targetListener = null;
  let navigationPromise = null;
  
  const waitForNavigationResult = tracer.startActiveSpan('detectNavigationOrNewTab', async (span) => {
    try {
      const timeout = 5000;
      const browser = page.browser();
      
      // Create a cleanup function to remove all listeners
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (targetListener && browser) {
          browser.off('targetcreated', targetListener);
          targetListener = null;
        }
      };
      
      return await new Promise((mainResolve) => {
        // First promise: navigation on the same page
        navigationPromise = page.waitForNavigation({ timeout })
          .then((result) => {
            logInfo('Navigation detected');
            span.setAttribute('navigation_type', 'same_page');
            cleanup();
            mainResolve(page);
            return page;
          })
          .catch(() => null);  // Just return null on timeout
        
        // Second promise: new tab detection
        targetListener = async (target) => {
          if (target.opener() === page.target()) {
            const newPage = await target.page();
            await newPage.bringToFront();
            logInfo('New tab detected');
            span.setAttribute('navigation_type', 'new_tab');
            cleanup();
            mainResolve(newPage);
          }
        };
        
        browser.on('targetcreated', targetListener);
        
        // Set the timeout to handle the case where neither navigation nor new tab occurs
        timeoutId = setTimeout(() => {
          logInfo('Navigation/tab timeout reached');
          span.setAttribute('navigation_type', 'none');
          cleanup();
          mainResolve(null);
        }, timeout);
      });
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
  
  return waitForNavigationResult;
}

// Function to perform the flow for a given combination of select options.
async function performFlow(browser, url, parentDir, client, selectCombination, mapping, flowIndex, clickLimit, classificationPromisesArray) {
  return tracer.startActiveSpan(`performFlow_${flowIndex}`, async (span) => {
    const flowStartTime = Date.now();
    let page = null;
    
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      await page.setViewport({ width: 1280, height: 800 });
      await page.evaluateOnNewDocument(() => {
        delete navigator.__proto__.webdriver;
      });
      await page.setDefaultNavigationTimeout(60000);

      span.setAttribute('flow_index', flowIndex);
      span.setAttribute('url', url);
      span.setAttribute('click_limit', clickLimit);
      span.setAttribute('has_select_combination', !!selectCombination);

      // Start page load trace
      const pageLoadStartTime = Date.now();
      await tracer.startActiveSpan('page_load', async (pageLoadSpan) => {
        try {
          await page.goto(url, { timeout: 60000, waitUntil: 'load' });
          const pageLoadDuration = Date.now() - pageLoadStartTime;
          pageLoadHistogram.record(pageLoadDuration);
          pageLoadSpan.setAttribute('duration_ms', pageLoadDuration);
          pageLoadSpan.setAttribute('url', url);
        } catch (error) {
          pageLoadSpan.recordException(error);
          throw error;
        } finally {
          pageLoadSpan.end();
        }
      });
      
      await sleep(Math.floor(Math.random() * 2000) + 1000);

      // Retrieve select identifiers for all select elements.
      const selectIdentifiers = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('select')).map((el, i) => {
          return { index: i, id: el.id || null, name: el.name || null };
        });
      });

      const actions = [];

      if (selectCombination && mapping && mapping.length > 0) {
        await tracer.startActiveSpan('apply_select_options', async (selectSpan) => {
          try {
            const selectElements = await page.$$('select');
            selectSpan.setAttribute('select_elements_count', selectElements.length);
            selectSpan.setAttribute('mapping_length', mapping.length);
            
            for (let uniqueIndex = 0; uniqueIndex < mapping.length; uniqueIndex++) {
              const value = selectCombination[uniqueIndex];
              for (let origIdx of mapping[uniqueIndex]) {
                const selectElement = selectElements[origIdx];
                const selectedValues = await selectElement.select(value);
                if (selectedValues.length === 0) {
                  logError(`Value "${value}" not found in select element at index ${origIdx}`);
                  selectSpan.setAttribute('error', `Value "${value}" not found in select element at index ${origIdx}`);
                  return;
                }
                logInfo(`Set select element at index ${origIdx} to value ${value}`);
                const newPage = await detectNavigationOrNewTab(page);
                if (newPage && newPage !== page) {
                  logInfo('Navigation or new tab detected after selecting option');
                  await page.close();
                  page = newPage;
                  await page.bringToFront();
                  selectSpan.setAttribute('navigation_after_select', true);
                }
              }
            }
            
            const fullSelectMapping = buildFullSelectMapping(mapping, selectCombination, selectIdentifiers);
            actions.push({
              selectOptions: fullSelectMapping
            });
          } catch (error) {
            selectSpan.recordException(error);
            throw error;
          } finally {
            selectSpan.end();
          }
        });
      } else {
        logInfo("No select options to set. Continuing flow without modifying selects.");
        actions.push({
          selectOptions: null
        });
      }
      
      await continueFlow(page, url, client, parentDir, flowIndex, 1, 0, clickLimit, selectCombination, actions, classificationPromisesArray);
      
    } catch (error) {
      logError('Error during flow', currentCrawlUrl, error);
      span.recordException(error);
    } finally {
      if (page && !page.isClosed()) {
        await page.close();
      }
      
      const flowDuration = Date.now() - flowStartTime;
      flowDurationHistogram.record(flowDuration);
      span.setAttribute('duration_ms', flowDuration);
      span.end();
    }
  });
}

function buildFullSelectMapping(mapping, uniqueCombination, selectIdentifiers) {
  return tracer.startActiveSpan('buildFullSelectMapping', (span) => {
    try {
      const fullMapping = new Array(selectIdentifiers.length);
      mapping.forEach((origIndices, uniqueIndex) => {
        origIndices.forEach((i) => {
          fullMapping[i] = {
            identifier: selectIdentifiers[i].id || selectIdentifiers[i].name || `select_${i}`,
            value: uniqueCombination[uniqueIndex]
          };
        });
      });
      
      span.setAttribute('mapping_entries', fullMapping.length);
      return fullMapping;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

const truncateString = (str, maxLength = 200) => {
  if (str.length > maxLength) {
    return str.slice(0, maxLength) + '...';
  }
  return str;
};

async function continueFlow(page, url, client, parentDir, flowIndex, screenshotIndex, clickCount, clickLimit, selectCombination, actions, classificationPromisesArray) {
  return tracer.startActiveSpan(`continueFlow_${flowIndex}`, async (span) => {
    span.setAttribute('flow_index', flowIndex);
    span.setAttribute('initial_click_count', clickCount);
    span.setAttribute('click_limit', clickLimit);
    
    try {
      const flowDirName = generateFlowDirectoryName(flowIndex);
      const flowDir = path.join(parentDir, flowDirName);

      await fillInputFields(page);

      const takeScreenshot = async () => {
        return tracer.startActiveSpan('takeScreenshot', async (screenshotSpan) => {
          screenshotSpan.setAttribute('screenshot_index', screenshotIndex);
          
          try {
            const screenshotPath = path.join(flowDir, generateFileName(screenshotIndex));
            screenshotSpan.setAttribute('screenshot_path', screenshotPath);
            
            if (!fs.existsSync(flowDir)) {
              fs.mkdirSync(flowDir, { recursive: true });
              logInfo(`Created flow directory: ${flowDir}`);
            }
            await page.screenshot({ path: screenshotPath });
            logInfo(`Screenshot saved to: ${screenshotPath}`);
            const currentUrl = await page.url();
            screenshotIndex++;
            return { screenshotPath, currentUrl };
          } catch (error) {
            screenshotSpan.recordException(error);
            throw error;
          } finally {
            screenshotSpan.end();
          }
        });
      };
      
      logInfo('Filled input fields, now taking screenshot');
      let { screenshotPath, currentUrl } = await takeScreenshot();
      logInfo('Sending screenshot for classification');
      
      classificationPromisesArray.push(
        classifyScreenshot(screenshotPath)
        .then(() => logInfo(`Classification sent for ${screenshotPath}`))
        .catch(err => logError(`Error sending screenshot ${screenshotPath}`, currentCrawlUrl, err))
      );

      const clickedPositions = new Set();
      let previousElementHTML = null;
      let shouldBreakLoop = false;

      while (clickCount < clickLimit && !shouldBreakLoop) {
        await tracer.startActiveSpan(`click_interaction_${clickCount}`, async (clickSpan) => {
          clickSpan.setAttribute('click_number', clickCount);
          clickSpan.setAttribute('current_url', currentUrl);
          
          try {
            const clickPositionStartTime = Date.now();
            client.write(`${screenshotPath}\n`);

            let clickPosition = await new Promise((resolve) => {
              const dataListener = (data) => {
                logInfo(`Received from server: ${data}`);
                client.removeListener('data', dataListener);
                resolve(data.toString().trim());
              };
              client.on('data', dataListener);
            });
            
            const clickPositionDuration = Date.now() - clickPositionStartTime;
            clickPositionRetrievalHistogram.record(clickPositionDuration);
            clickSpan.setAttribute('click_position_retrieval_ms', clickPositionDuration);
            clickSpan.setAttribute('click_position_response', clickPosition);

            const match = clickPosition.match(/Click Point:\s*(\d+),\s*(\d+)/);
            if (clickPosition === 'No login button detected' || clickPosition === 'Error: No relevant element detected.') {
              logInfo('No login button detected');
              clickSpan.setAttribute('result', 'no_login_button');
              actions.push({
                step: actions.length,
                clickPosition: null,
                elementHTML: null,
                screenshot: screenshotPath,
                url: currentUrl,
              });
              shouldBreakLoop = true;
              return;
            } else if (clickPosition === 'No popups found') {
              logInfo('No popups found');
              clickSpan.setAttribute('result', 'no_popups');
              shouldBreakLoop = false;
              return;
            } else if (!match) {
              logError(`Invalid data received from socket: ${clickPosition}`, currentCrawlUrl);
              clickSpan.setAttribute('result', 'invalid_data');
              clickSpan.recordException(new Error(`Invalid click position: ${clickPosition}`));
              shouldBreakLoop = true;
              return;
            }

            const [x, y] = match.slice(1).map(Number);
            const positionKey = `${x},${y}`;
            
            if (clickedPositions.has(positionKey)) {
              logInfo(`Already clicked at position (${x}, ${y}). Skipping to avoid infinite loop.`);
              clickSpan.setAttribute('result', 'repeated_click_position');
              shouldBreakLoop = true;
              return;
            }
            
            clickedPositions.add(positionKey);
            
            clickSpan.setAttribute('click_x', x);
            clickSpan.setAttribute('click_y', y);

            const currentElementHTML = await page.evaluate(({ x, y }) => {
              const element = document.elementFromPoint(x, y);
              return element ? element.outerHTML : null;
            }, { x, y });

            if (currentElementHTML === null) {
              logInfo('No element found at the click position.');
              clickSpan.setAttribute('result', 'no_element');
              actions.push({
                step: actions.length,
                clickPosition: null,
                elementHTML: null,
                screenshot: screenshotPath,
                url: currentUrl,
              });
              shouldBreakLoop = true;
              return;
            }

            logInfo(`Element at position (${x}, ${y}): ${currentElementHTML.slice(0, 100)}...`);
            
            if (currentElementHTML === previousElementHTML) {
              logInfo('Same element as previous click detected. Stopping flow to avoid loop.');
              clickSpan.setAttribute('result', 'repeated_element');
              clickSpan.setAttribute('same_as_previous', true);
              actions.push({
                step: actions.length,
                clickPosition: { x, y },
                elementHTML: truncateString(currentElementHTML),
                screenshot: screenshotPath,
                url: currentUrl,
                note: "Flow stopped: same element as previous click"
              });
              shouldBreakLoop = true;
              return;
            }

            previousElementHTML = currentElementHTML;

            actions.push({
              step: actions.length,
              clickPosition: { x, y },
              elementHTML: truncateString(currentElementHTML),
              screenshot: screenshotPath,
              url: currentUrl,
            });

            await overlayClickPosition(screenshotPath, screenshotPath, x, y);
            logInfo(`Clicking at position: (${x}, ${y})`);
            await page.mouse.move(x - 5, y - 5);
            await sleep(Math.floor(Math.random() * 1000) + 500);
            await page.mouse.click(x, y);
            clickCounter.add(1);

            clickCount++;

            const newPage = await detectNavigationOrNewTab(page);
            if (newPage && newPage !== page) {
              logInfo('New tab or navigation detected after click, switching to new page');
              await page.close();
              page = newPage;
              await page.bringToFront();
              await page.setDefaultNavigationTimeout(60000);
              clickSpan.setAttribute('navigation_after_click', true);
            }

            await fillInputFields(page);
            await sleep(4000);
            ({ screenshotPath, currentUrl } = await takeScreenshot());
            
            classificationPromisesArray.push(
              classifyScreenshot(screenshotPath)
              .then(() => logInfo(`Classification sent for ${screenshotPath}`))
              .catch(err => logError(`Error sending screenshot ${screenshotPath}`, currentCrawlUrl, err))
            );
              
            clickSpan.setAttribute('result', 'success');
          } catch (error) {
            clickSpan.recordException(error);
            shouldBreakLoop = true;
            throw error;
          } finally {
            clickSpan.end();
          }
        }).catch(error => {
          logError(`Error during click interaction: ${error.message}`, currentCrawlUrl, error);
          shouldBreakLoop = true;
        });

        if (shouldBreakLoop) {
          break;
        }
      }

      if ((shouldBreakLoop || clickCount >= clickLimit) && 
          (actions.length === 0 || actions[actions.length - 1].clickPosition !== null)) {
        actions.push({
          step: actions.length,
          clickPosition: null,
          elementHTML: null,
          screenshot: screenshotPath,
          url: currentUrl,
          note: shouldBreakLoop ? "Flow terminated early" : "Click limit reached"
        });
      }
      
      await tracer.startActiveSpan('write_actions_json', async (writeSpan) => {
        writeSpan.setAttribute('flow_index', flowIndex);
        
        try {
          const outputJSONPath = path.join(flowDir, `click_actions_flow_${flowIndex}.json`);
          writeSpan.setAttribute('json_path', outputJSONPath);
          writeSpan.setAttribute('actions_count', actions.length);
          
          fs.writeFileSync(outputJSONPath, JSON.stringify(actions, null, 2));
          logInfo(`Actions saved to: ${outputJSONPath}`);
        } catch (error) {
          writeSpan.recordException(error);
          throw error;
        } finally {
          writeSpan.end();
        }
      });
      
      span.setAttribute('total_clicks', clickCount);
      span.setAttribute('actions_recorded', actions.length);
      span.setAttribute('early_termination', shouldBreakLoop);
      
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
async function connectSocketWithRetry(host, port) {
  return tracer.startActiveSpan('socket_connection', async (span) => {
    span.setAttribute('host', host);
    span.setAttribute('port', port);
    
    const client = new net.Socket();
    let retryCount = 0;
    
    try {
      await new Promise((resolve, reject) => {
        const retryInterval = 1000; // Retry every 1 second
        let timeout;

        const handleError = (err) => {
          logError(`Socket error: ${err.message}. Retrying connection in ${retryInterval / 1000} seconds...`, currentCrawlUrl, err);
          span.setAttribute('last_error', err.message);
          clearTimeout(timeout);
          timeout = setTimeout(tryConnect, retryInterval);
        };

        const tryConnect = () => {
          retryCount++;
          span.setAttribute('retry_count', retryCount);
          
          client.once('error', handleError);
          
          client.connect(port, host, () => {
            client.removeListener('error', handleError);
            logInfo('Connected to socket server');
            span.setAttribute('connected', true);
            resolve();
          });
        };

        tryConnect();
      });
      
      return client;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
async function runCrawler(url) {
  currentCrawlUrl = url;
  let classificationPromises = [];
  return tracer.startActiveSpan('runCrawler', async (span) => {
    span.setAttribute('url', url);
    
    const crawlStartTime = Date.now();
    const HOST = process.env.VLLM_BACKEND_HOST || '172.17.0.1';
    const PORT = parseInt(process.env.VLLM_BACKEND_PORT || '5000');
    let client;
    let browser;

    try {
      client = await connectSocketWithRetry(HOST, PORT);

      browser = await tracer.startActiveSpan('browser_launch', async (browserSpan) => {
        try {
          const browser = await puppeteer.launch({
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-gpu',
              '--start-fullscreen',
              '--disable-blink-features=AutomationControlled',
            ],
          });
          browserSpan.setAttribute('success', true);
          return browser;
        } catch (error) {
          browserSpan.recordException(error);
          throw error;
        } finally {
          browserSpan.end();
        }
      });

      const CLICK_LIMIT = 5;
      span.setAttribute('click_limit', CLICK_LIMIT);

      const parentDir = path.join(__dirname, '/screenshot_flows', generateParentDirectoryName(url));
      span.setAttribute('parent_dir', parentDir);
      logInfo(`Parent directory path: ${parentDir}`);

      await tracer.startActiveSpan('cleanup_directory_contents', async (cleanupSpan) => {
        try {
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
            logInfo(`Created parent directory: ${parentDir}`);
            return;
          }
          
          logInfo(`Cleaning up contents of existing directory: ${parentDir}`);
          cleanupSpan.setAttribute('directory', parentDir);
          
          const dirContents = fs.readdirSync(parentDir);
          logInfo(`Directory contents to clean: ${dirContents.length} items`);
          cleanupSpan.setAttribute('item_count', dirContents.length);
          
          const cleanDirectoryContents = function(dirPath, isRoot = true) {
            if (fs.existsSync(dirPath)) {
              fs.readdirSync(dirPath).forEach((file) => {
                const curPath = path.join(dirPath, file);
                
                try {
                  if (fs.lstatSync(curPath).isDirectory()) {
                    cleanDirectoryContents(curPath, false);
                    if (!isRoot) {
                      fs.rmdirSync(curPath);
                      logInfo(`Deleted subdirectory: ${curPath}`);
                    }
                  } else {
                    fs.unlinkSync(curPath);
                    logInfo(`Deleted file: ${curPath}`);
                  }
                } catch (e) {
                  logError(`Failed to process ${curPath}: ${e.message}`, currentCrawlUrl, e);
                  cleanupSpan.recordException(e);
                }
              });
            }
          };
          
          cleanDirectoryContents(parentDir);
          logInfo(`Completed cleaning directory contents`);
          
          const remainingItems = fs.existsSync(parentDir) ? fs.readdirSync(parentDir).length : 0;
          cleanupSpan.setAttribute('remaining_items', remainingItems);
          logInfo(`Directory cleanup complete. Remaining items: ${remainingItems}`);
          
        } catch (err) {
          logError(`Unexpected error during directory cleanup: ${err.message}`, currentCrawlUrl, err);
          cleanupSpan.recordException(err);
        } finally {
          cleanupSpan.end();
        }
      });

      let selectOptions = [];
      await tracer.startActiveSpan('get_initial_select_options', async (selectSpan) => {
        try {
          let page = await browser.newPage();
          await page.goto(url, { waitUntil: 'load' });
          await sleep(Math.floor(Math.random() * 2000) + 1000);

          selectOptions = await getSelectOptions(page);
          selectSpan.setAttribute('select_options_count', selectOptions.length);
          await page.close();
        } catch (error) {
          selectSpan.recordException(error);
          throw error;
        } finally {
          selectSpan.end();
        }
      });
      

      if (selectOptions.length === 0) {
        logInfo("No select options found. Running flow without select options.");
        span.setAttribute('has_select_options', false);
        await performFlow(browser, url, parentDir, client, null, [], 0, CLICK_LIMIT, classificationPromises);
      } else {
        span.setAttribute('has_select_options', true);
        
        const { uniqueOptions, mapping } = deduplicateOptionsWithMapping(selectOptions);
        span.setAttribute('unique_option_groups', uniqueOptions.length);
        
        const defaultCombination = uniqueOptions.map(options => options[0]);

        const flows = [];
        uniqueOptions.forEach((options, groupIndex) => {
          options.forEach(option => {
            if (option !== defaultCombination[groupIndex]) {
              const variation = [...defaultCombination];
              variation[groupIndex] = option;
              flows.push(variation);
            }
          });
        });
        logInfo(`Generated ${flows.length} flows based on unique select options.`);
        span.setAttribute('total_flows', flows.length);

        for (let i = 0; i < flows.length && i < 20; i++) {
          const selectCombination = flows[i];
          logInfo(`Starting flow ${i} with select options: ${selectCombination}`);
          await performFlow(browser, url, parentDir, client, selectCombination, mapping, i, CLICK_LIMIT, classificationPromises);
        }
      }
    } catch (error) {
      logError(`Error: ${error.message}`, currentCrawlUrl, error);
      span.recordException(error);
    } finally {
      if (browser) {
        await Promise.all(classificationPromises);
        await browser.close();
        logInfo('Browser closed');
      }
      if (client) {
        client.end();
        client.destroy();
        logInfo('Socket connection closed');
      }
      
      const crawlDuration = Date.now() - crawlStartTime;
      crawlDurationHistogram.record(crawlDuration);
      span.setAttribute('duration_ms' , crawlDuration);
      span.end();
    }
  });
}

// Function to read URLs from the file and add "http://" if not present
function getUrlsFromFile(filePath) {
  return tracer.startActiveSpan('getUrlsFromFile', (span) => {
    try {
      span.setAttribute('file_path', filePath);
      
      const urls = fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((url) => (url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`));
      
      span.setAttribute('url_count', urls.length);
      return urls;
    } catch (error) {
      logError(`Error reading file: ${error.message}`, currentCrawlUrl, error);
      span.recordException(error);
      return [];
    } finally {
      span.end();
    }
  });
}

async function main() {
  return tracer.startActiveSpan('crawler_execution', async (mainSpan) => {
    try {
      const args = process.argv.slice(2);
      let url = args[0];

      if (!url) {
        logError('Invalid URL passed in', currentCrawlUrl);
        mainSpan.setAttribute('error', 'invalid_url');
        return;
      }

      if (!url.startsWith('http')) {
        url = 'http://' + url;
      }

      mainSpan.setAttribute('target_url', url);
      logInfo(`Processing single URL from arguments: ${url}`);
      
      try {
        await runCrawler(url);
      } catch (error) {
        logError(`Error processing URL ${url}: ${error.message}`, url, error);
        mainSpan.recordException(error);
      }

      logInfo('Finished processing all URLs.');
    } catch (error) {
      logError(`Unexpected error in main function: ${error.message}`, currentCrawlUrl, error);
      mainSpan.recordException(error);
    } finally {
      mainSpan.end();
      await sdk.shutdown();
      process.exit(0);
    }
  });
}

// Entry point
main().finally(() => {
  // Ensure that the SDK is properly shut down after the crawl is done
  sdk.shutdown().finally(() => {
    console.log("Logs flushed and OpenTelemetry SDK shut down.");
    // Optionally exit the process (0 for success, 1 for failure)
    process.exit(0); // Or process.exit(1) based on the result you want
  });
}).catch(err => {
  // Log the error if something goes wrong
  logError(`Fatal Error: ${err.message}`, currentCrawlUrl, err);
});

