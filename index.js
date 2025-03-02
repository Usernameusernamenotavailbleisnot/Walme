const fs = require('fs').promises;
const axios = require('axios');
const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
const HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

// Initialize chalk properly
let chalk;
(async () => {
    chalk = (await import('chalk')).default;
    // Only start the bot after chalk is loaded
    await startBot();
})();

// Constants and Configuration
const BASE_URL = 'https://api.walme.io/waitlist/tasks';
const PROFILE_URL = 'https://api.walme.io/user/profile';
const PROXIES_FILE = 'proxies.txt';

// Configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000; // 3 seconds
const REQUEST_TIMEOUT = 15000; // 15 seconds

// List of common proxy error codes
const PROXY_ERROR_CODES = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH',
    'ENOTFOUND', 'ESOCKETTIMEDOUT', 'EPROTO', 'ECONNABORTED',
    'EADDRNOTAVAIL', 'ENETUNREACH'
];

async function getAccessTokens() {
    try {
        const tokenData = await fs.readFile('tokens.txt', 'utf8');
        const tokens = tokenData.split('\n')
            .map(token => token.trim())
            .filter(token => token.length > 0);
        
        if (tokens.length === 0) {
            throw new Error('No tokens found in tokens.txt');
        }
        return tokens;
    } catch (error) {
        console.error(chalk.red.bold(`[ERROR] Failed to read tokens from tokens.txt: ${error.message}`));
        throw error;
    }
}

async function getProxies() {
    try {
        const proxyData = await fs.readFile(PROXIES_FILE, 'utf8');
        const proxies = proxyData.split('\n')
            .map(proxy => proxy.trim())
            .filter(proxy => proxy.length > 0);
        
        if (proxies.length === 0) {
            console.log(chalk.yellow(`[WARNING] No proxies found in ${PROXIES_FILE}. Running without proxies.`));
            return [];
        }
        
        console.log(chalk.white(`🌐 [INFO] Loaded ${proxies.length} proxies from ${PROXIES_FILE}`));
        return proxies;
    } catch (error) {
        console.error(chalk.yellow(`[WARNING] Failed to read proxies from ${PROXIES_FILE}: ${error.message}. Running without proxies.`));
        return [];
    }
}

function createProxyAgent(proxyString) {
    try {
        let protocol, host, port, auth;
        
        if (proxyString.includes('://')) {
            const url = new URL(proxyString);
            protocol = url.protocol.replace(':', '');
            host = url.hostname;
            port = url.port;
            auth = url.username && url.password ? `${url.username}:${url.password}` : null;
        } 
        else {
            const parts = proxyString.split(':');
            if (parts.length >= 2) {
                if (parts.length === 2) {
                    
                    [host, port] = parts;
                    protocol = 'http';
                } else if (parts.length === 4) {
                    
                    [host, port, ...auth] = parts;
                    auth = auth.join(':');
                    protocol = 'http'; 
                } else if (proxyString.includes('@')) {
                    const [credentials, server] = proxyString.split('@');
                    auth = credentials;
                    [host, port] = server.split(':');
                    protocol = 'http'; 
                }
            }
        }
        
        if (!host || !port) {
            throw new Error(`Invalid proxy format: ${proxyString}`);
        }
        
        let proxyType = protocol?.toLowerCase() || 'http';
        
        if (proxyType.startsWith('socks')) {
            const socksOptions = {
                hostname: host,
                port: parseInt(port)
            };
            
            if (auth) {
                const [username, password] = auth.split(':');
                socksOptions.username = username;
                socksOptions.password = password;
            }
            
            const socksUrl = `socks${proxyType.endsWith('5') ? '5' : '4'}://${auth ? auth + '@' : ''}${host}:${port}`;
            return new SocksProxyAgent(socksUrl);
        } 
        else {
            const httpProxyUrl = `http://${auth ? auth + '@' : ''}${host}:${port}`;
            return {
                http: new HttpProxyAgent(httpProxyUrl),
                https: new HttpsProxyAgent(httpProxyUrl)
            };
        }
    } catch (error) {
        console.error(chalk.red.bold(`[ERROR] Failed to create proxy agent: ${error.message}`));
        return null;
    }
}

// Function to check if an error is a proxy-related error
function isProxyError(error) {
    if (!error) return false;
    
    // Check for axios error with code
    if (error.code && PROXY_ERROR_CODES.includes(error.code)) {
        return true;
    }
    
    // Check for network errors in axios
    if (error.message && (
        error.message.includes('socket hang up') ||
        error.message.includes('Client network socket disconnected') ||
        error.message.includes('read ECONNRESET') ||
        error.message.includes('connect ETIMEDOUT') ||
        error.message.includes('connect ECONNREFUSED') ||
        error.message.includes('getaddrinfo ENOTFOUND') ||
        error.message.includes('ECONN') ||
        error.message.includes('ETIMEOUT') ||
        error.message.includes('EPROTO') ||
        error.message.includes('ECONNABORTED') ||
        error.message.includes('ERR_PROXY')
    )) {
        return true;
    }
    
    // Check for HTTP status codes that might indicate proxy issues
    if (error.response && (error.response.status === 407 || error.response.status === 502 || 
                          error.response.status === 503 || error.response.status === 504)) {
        return true;
    }
    
    return false;
}

// Create axios config with proxy and timeout
function createRequestConfig(token, proxyAgent) {
    const config = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT
    };
    
    if (proxyAgent) {
        if (proxyAgent.http && proxyAgent.https) {
            config.httpAgent = proxyAgent.http;
            config.httpsAgent = proxyAgent.https;
        } else {
            config.httpsAgent = proxyAgent;
            config.httpAgent = proxyAgent;
        }
    }
    
    return config;
}

// Retry function for API requests using the same proxy
async function retryApiRequest(requestFn, args, proxyString, maxRetries = MAX_RETRIES) {
    let proxyAgent = null;
    if (proxyString) {
        proxyAgent = createProxyAgent(proxyString);
        if (!proxyAgent) {
            console.log(chalk.yellow(`[WARNING] Failed to create proxy agent for: ${proxyString}. Continuing without proxy.`));
        } else {
            console.log(chalk.white(`🌐 [INFO] Using proxy: ${proxyString.replace(/:[^:]*@/, ':****@')}`));
        }
    }
    
    // Extract token from args
    const token = args[0];
    
    // Calculate progressive backoff delays for retries
    const getBackoffDelay = (attempt) => {
        // Exponential backoff: starts with RETRY_DELAY and increases
        return RETRY_DELAY * Math.pow(1.5, attempt - 1);
    };
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Call the request function with appropriate arguments
            return await requestFn(...args, proxyAgent);
        } catch (error) {
            const isProxy = isProxyError(error);
            const errorCode = error.code || 'unknown';
            const errorMessage = error.message || 'No error message';
            const httpStatus = error.response?.status ? `HTTP ${error.response.status}` : '';
            const errorDetails = httpStatus ? `${errorCode} (${httpStatus})` : errorCode;
            
            if (attempt < maxRetries) {
                // Calculate delay for this retry with backoff
                const retryDelay = getBackoffDelay(attempt);
                
                if (isProxy) {
                    console.error(chalk.yellow(`🔄 [RETRY] Proxy error (${errorDetails}): ${errorMessage}`));
                    console.log(chalk.yellow(`🔄 [RETRY] Attempt ${attempt}/${maxRetries} - Retrying in ${retryDelay/1000} seconds...`));
                } else {
                    console.error(chalk.red(`❌ [ERROR] Request failed: ${errorMessage}`));
                    console.log(chalk.yellow(`🔄 [RETRY] Attempt ${attempt}/${maxRetries} - Retrying in ${retryDelay/1000} seconds...`));
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                
                // For proxy errors, recreate the proxy agent (helps with some connection issues)
                if (isProxy && proxyString) {
                    proxyAgent = createProxyAgent(proxyString);
                    console.log(chalk.white(`🌐 [INFO] Recreated proxy agent for retry`));
                }
            } else {
                // Last attempt failed
                if (isProxy) {
                    console.error(chalk.red.bold(`💥 [ERROR] All ${maxRetries} proxy retry attempts failed: ${errorMessage}`));
                } else {
                    console.error(chalk.red.bold(`💥 [ERROR] All ${maxRetries} retry attempts failed: ${errorMessage}`));
                }
                throw error;
            }
        }
    }
}

async function getUserProfile(token, proxyAgent) {
    try {
        const config = createRequestConfig(token, proxyAgent);
        const response = await axios.get(PROFILE_URL, config);
        
        // Extract data from response safely with defaults
        const email = response.data?.email || null;
        const nickname = response.data?.nickname || 'unknown_user';
        // Use nickname as userId if email is not available
        const userId = email || nickname || `user_${Date.now()}`; 
        
        console.log(chalk.white(`✨ [INFO] Profile fetched - Email: ${email || 'not available'}, Nickname: ${nickname}`));
        return { 
            email, 
            nickname, 
            userId 
        };
    } catch (error) {
        console.error(chalk.red.bold(`[ERROR] Failed to fetch user profile: ${error.response?.data?.message || error.message}`));
        throw new Error(`Profile fetch failed: ${error.message}`);
    }
}

async function getTasks(token, proxyAgent) {
    try {
        const config = createRequestConfig(token, proxyAgent);
        const response = await axios.get(BASE_URL, config);
        return response.data;
    } catch (error) {
        console.error(chalk.red.bold(`[ERROR] Failed to fetch task list: ${error.response?.data?.message || error.message}`));
        throw error;
    }
}

// Modified task processing to fix the null error
async function completeTask(taskId, token, proxyAgent) {
    try {
        const config = createRequestConfig(token, proxyAgent);
        const response = await axios.patch(`${BASE_URL}/${taskId}`, {}, config);
        console.log(chalk.green(`✅ [SUCCESS] Task ${taskId} processed: ${response.data.title}`));
        return response.data;
    } catch (error) {
        console.error(chalk.red.bold(`[ERROR] Failed to process task ${taskId}: ${error.response?.data?.message || error.message}`));
        throw error;
    }
}

function startCountdown(duration = 24) {
    const nextRun = new Date();
    nextRun.setHours(nextRun.getHours() + duration);
    const totalMs = duration * 60 * 60 * 1000;

    console.log(chalk.blue.bold(`🕒 [INFO] Next run scheduled in ${duration} hour(s) at ${nextRun.toLocaleTimeString()}`));

    const interval = setInterval(() => {
        const now = new Date();
        const timeLeft = nextRun - now;

        if (timeLeft <= 0) {
            clearInterval(interval);
            console.log(chalk.blue.bold('🚀 [INFO] Countdown complete. Starting next run...'));
        } else {
            const hours = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

            const progress = Math.floor((1 - timeLeft / totalMs) * 10);
            const bar = '█'.repeat(progress) + '░'.repeat(10 - progress);

            process.stdout.write(
                `\r${chalk.yellow('⏰ [INFO] Next run in:')} ${hours}h ${minutes}m ${seconds}s ${chalk.white(`[${bar}]`)}`
            );
        }
    }, 1000);

    return nextRun;
}

// Function to handle the daily challenge task specifically
async function processDailyChallenge(token, tasks, proxyAgent) {
    try {
        // Find the daily challenge task by title, type, and group instead of ID
        const dailyTask = tasks.find(task => 
            (task.title && task.title.includes('7-DAY Challenge')) || 
            (task.group === 'daily' && task.iterable === true && task.type === 'dummy')
        );
        
        if (!dailyTask) {
            console.log(chalk.yellow(`⚠️ [INFO] Daily challenge task not found`));
            return false;
        }
        
        const dailyChallengeId = dailyTask.id;
        console.log(chalk.yellow(`🌟 [INFO] Found daily challenge with ID: ${dailyChallengeId}`));
        
        // Check if the task is already completed for today (status will be completed or started)
        if (dailyTask.status === 'completed' || dailyTask.status === 'started') {
            const dayInfo = dailyTask.iterator?.day || 'unknown';
            console.log(chalk.yellow(`⏳ [INFO] Daily challenge already active (Day ${dayInfo})`));
            return true;
        }
        
        // Process the daily challenge
        console.log(chalk.yellow(`🌟 [INFO] Processing daily challenge...`));
        
        const config = createRequestConfig(token, proxyAgent);
        const response = await axios.patch(`${BASE_URL}/${dailyChallengeId}`, {}, config);
        
        if (response.data && response.data.iterator) {
            const { day, reward } = response.data.iterator;
            console.log(chalk.green(`✅ [SUCCESS] Daily challenge Day ${day} completed! Earned ${reward} XP`));
            
            if (day === 7) {
                console.log(chalk.green.bold(`🎉 [SUCCESS] 7-Day Challenge completed! Full XP Boost earned!`));
            }
        } else {
            console.log(chalk.green(`✅ [SUCCESS] Daily challenge completed!`));
        }
        
        return true;
    } catch (error) {
        console.error(chalk.red(`❌ [ERROR] Failed to process daily challenge: ${error.message}`));
        return false;
    }
}

async function processAccount(token, proxyString) {
    let profile = null;
    let proxyAgent = null;
    
    try {
        // Create proxy agent if proxy string provided
        if (proxyString) {
            proxyAgent = createProxyAgent(proxyString);
        }
        
        // Get user profile
        console.log(chalk.white('👤 [INFO] Fetching user profile...'));
        try {
            profile = await retryApiRequest(getUserProfile, [token], proxyString);
        } catch (profileError) {
            console.error(chalk.red.bold(`[ERROR] Failed to fetch profile: ${profileError.message}`));
            return; // Exit early if profile fetch fails
        }
        
        // Make sure we have a nickname for display
        const nickname = profile?.nickname || 'unknown_user';
        
        // Fetch task list
        console.log(chalk.white(`📋 [INFO] ${nickname} - Fetching task list...`));
        let tasks = [];
        try {
            tasks = await retryApiRequest(getTasks, [token], proxyString);
            console.log(chalk.white(`📋 [INFO] ${nickname} - Task list fetched, total tasks: ${tasks.length}`));
        } catch (tasksError) {
            console.error(chalk.red.bold(`[ERROR] ${nickname} - Failed to fetch tasks: ${tasksError.message}`));
            return; // Exit early if task fetch fails
        }

        // First, handle the daily challenge task
        let dailyChallengeSuccess = false;
        try {
            dailyChallengeSuccess = await processDailyChallenge(token, tasks, proxyAgent);
        } catch (dcError) {
            console.error(chalk.red(`❌ [ERROR] ${nickname} - Error in daily challenge: ${dcError.message}`));
        }

        const pendingTasks = tasks.filter(task => {
            // Check if this is a daily challenge task
            const isDailyChallenge = (task.title && task.title.includes('7-DAY Challenge')) || 
                                     (task.group === 'daily' && task.iterable === true && task.type === 'dummy');
            
            // Only include non-daily-challenge tasks that need to be processed
            return (task.status === 'new' || task.status === 'failed') && !isDailyChallenge;
        });
        console.log(chalk.white(`📋 [INFO] ${nickname} - Pending tasks: ${pendingTasks.length}`));

        // Initialize task counter
        let completedTaskCount = 0;
        let failedTaskCount = 0;

        for (const task of pendingTasks) {
            console.log(chalk.yellow(`🔧 [INFO] ${nickname} - Processing task: ${task.title} (ID: ${task.id})`));

            try {
                if (task.child && task.child.length > 0) {
                    for (const childTask of task.child) {
                        if (childTask.status === 'new' || childTask.status === 'failed') {
                            try {
                                // Create config for this request
                                const config = createRequestConfig(token, proxyAgent);
                                
                                // Complete the task directly
                                await axios.patch(`${BASE_URL}/${childTask.id}`, {}, config);
                                
                                completedTaskCount++;
                                console.log(chalk.green(`✅ [SUCCESS] ${nickname} - Completed child task: ${childTask.title} (ID: ${childTask.id})`));
                                
                                // Add random delay between 1-3 seconds
                                const delay = 1000 + Math.random() * 2000;
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } catch (childTaskError) {
                                failedTaskCount++;
                                console.error(chalk.red(`❌ [ERROR] ${nickname} - Failed to complete child task ${childTask.id}: ${childTaskError.message}`));
                            }
                        }
                    }
                } else {
                    // Create config for this request
                    const config = createRequestConfig(token, proxyAgent);
                    
                    // Complete the task directly
                    await axios.patch(`${BASE_URL}/${task.id}`, {}, config);
                    
                    completedTaskCount++;
                    console.log(chalk.green(`✅ [SUCCESS] ${nickname} - Completed task: ${task.title} (ID: ${task.id})`));
                    
                    // Add random delay between 1-3 seconds
                    const delay = 1000 + Math.random() * 2000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (taskError) {
                failedTaskCount++;
                console.error(chalk.red(`❌ [ERROR] ${nickname} - Failed to complete task ${task.id}: ${taskError.message}`));
            }
        }

        console.log(chalk.green.bold(`🎉 [SUCCESS] ${nickname} - Processed ${completedTaskCount} tasks successfully, ${failedTaskCount} tasks failed`));
        
        // Daily challenge status
        if (dailyChallengeSuccess) {
            console.log(chalk.blue(`ℹ️ [INFO] ${nickname} - Daily challenge processed successfully`));
        }
        
    } catch (error) {
        const displayName = profile?.nickname || 'unknown account';
        
        if (isProxyError(error)) {
            console.error(chalk.red.bold(`💥 [ERROR] ${displayName} - Proxy error: ${error.code || error.message}`));
        } else {
            console.error(chalk.red.bold(`💥 [ERROR] ${displayName} - Account processing failed: ${error.message}`));
        }
    }
}

async function runBot() {
    try {
        console.log(chalk.cyan.bold('═══════════════════════════════════════'));
        console.log(chalk.cyan.bold('   Walme Auto Bot - Airdrop Insiders   '));
        console.log(chalk.cyan.bold('═══════════════════════════════════════'));
        console.log(chalk.cyan.bold(`   ${new Date().toLocaleString()}   `));
        console.log(chalk.cyan.bold('═══════════════════════════════════════'));

        console.log(chalk.white('🔑 [INFO] Fetching access tokens...'));
        const tokens = await getAccessTokens();
        console.log(chalk.white(`🔑 [INFO] ${tokens.length} tokens fetched successfully`));

        console.log(chalk.white('🌐 [INFO] Loading proxies...'));
        const proxies = await getProxies();
        
        // Track failed proxy counters
        const proxyFailures = {};
        if (proxies.length > 0) {
            proxies.forEach(proxy => {
                proxyFailures[proxy] = 0;
            });
        }

        while (true) {
            console.log(chalk.cyan('─'.repeat(40)));

            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                // Select proxy for this account with failure tracking
                let proxyString = null;
                if (proxies.length > 0) {
                    // Find proxies with fewer failures
                    const healthyProxies = proxies.filter(p => proxyFailures[p] < 3);
                    
                    if (healthyProxies.length > 0) {
                        const proxyIndex = i % healthyProxies.length;
                        proxyString = healthyProxies[proxyIndex];
                    } else {
                        // Reset failure counters if all proxies have issues
                        console.log(chalk.yellow('⚠️ [WARNING] All proxies have high failure counts. Resetting counters.'));
                        proxies.forEach(proxy => {
                            proxyFailures[proxy] = 0;
                        });
                        const proxyIndex = i % proxies.length;
                        proxyString = proxies[proxyIndex];
                    }
                }
                
                // Process account with retry mechanism
                try {
                    await processAccount(token, proxyString);
                } catch (accError) {
                    // If proxy error, increment failure counter
                    if (proxyString && isProxyError(accError)) {
                        proxyFailures[proxyString] = (proxyFailures[proxyString] || 0) + 1;
                        console.log(chalk.yellow(`⚠️ [WARNING] Proxy ${proxyString.replace(/:[^:]*@/, ':****@')} failed ${proxyFailures[proxyString]} times`));
                    }
                }
                
                // Random delay between accounts to avoid pattern detection
                const accountDelay = 2000 + Math.random() * 3000;
                await new Promise(resolve => setTimeout(resolve, accountDelay)); 
            }
            
            // Log healthy and problematic proxies
            if (proxies.length > 0) {
                const problematicProxies = proxies.filter(p => proxyFailures[p] >= 2);
                if (problematicProxies.length > 0) {
                    console.log(chalk.yellow('⚠️ [WARNING] Problematic proxies:'));
                    problematicProxies.forEach(p => {
                        console.log(chalk.yellow(`  - ${p.replace(/:[^:]*@/, ':****@')}: ${proxyFailures[p]} failures`));
                    });
                }
            }

            // Shorter interval for testing - adjust as needed
            const runInterval = 3; // hours
            const nextRunTime = startCountdown(runInterval);
            await new Promise(resolve => setTimeout(resolve, nextRunTime - new Date()));
            console.log('');
        }
    } catch (error) {
        console.error(chalk.red.bold(`💥 [ERROR] Bot execution failed: ${error.message}`));
        console.log(chalk.yellow('🔄 [INFO] Restarting bot in 1 minute...'));
        // Restart the bot after 1 minute
        setTimeout(() => runBot(), 60 * 1000);
    }
}

// Remove the auto-start at the bottom since we're starting from the initialization
async function startBot() {
    try {
        // Catch-all wrapper to ensure the bot restarts if it crashes
        await runBot();
    } catch (error) {
        console.error(chalk.red.bold(`💥 [CRITICAL ERROR] Bot crashed: ${error.message}`));
        console.log(chalk.yellow('🔄 [INFO] Restarting bot in 1 minute...'));
        // Restart the bot after 1 minute
        setTimeout(() => startBot(), 60 * 1000);
    }
}
