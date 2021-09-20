/**
 * Script for landing.ejs
 */
// Requirements
const cp = require('child_process')

// Internal Requirements
const ProcessBuilder = require('./assets/js/processbuilder')

// Launch Elements
const launch_button = document.getElementById("launch_button")
const launch_content = document.getElementById('launch_content')
const launch_details = document.getElementById('launch_details')
const launch_progress = document.getElementById('launch_progress')
const launch_progress_label = document.getElementById('launch_progress_label')
const launch_details_text = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')

const loggerLanding = LoggerUtil('%c[Landing]', 'color: #000668; font-weight: bold')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading) {
    if (loading) {
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details) {
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} value The progress value.
 * @param {number} max The total size.
 * @param {number|string} percent Optional. The percentage to display on the progress label.
 */
function setLaunchPercentage(value, max, percent = ((value / max) * 100)) {
    launch_progress.setAttribute('max', max)
    launch_progress.setAttribute('value', value)
    launch_progress_label.innerHTML = percent + '%'
    launch_button.childNodes[1].childNodes[3].textContent = `Launching (${percent}%)`
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} value The progress value.
 * @param {number} max The total download size.
 * @param {number|string} percent Optional. The percentage to display on the progress label.
 */
function setDownloadPercentage(value, max, percent = ((value / max) * 100)) {
    remote.getCurrentWindow().setProgressBar(value / max)
    launch_progress.setAttribute('max', max)
    launch_progress.setAttribute('value', value)
    launch_progress_label.innerHTML = percent + '%'
    launch_button.childNodes[1].childNodes[3].textContent = `Downloading (${percent}%)`
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val) {
    launch_button.disabled = !val;
}

// Bind launch button
launch_button.addEventListener('click', function (e) {
    loggerLanding.log('Launching game..')
    const mcVersion = '1.8.9'
    const jExe = ConfigManager.getJavaExecutable()
    if (jExe == null) {
        asyncSystemScan(mcVersion)
    } else {

        setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
        toggleLaunchArea(true)
        setLaunchPercentage(0, 100)

        const jg = new JavaGuard(mcVersion)
        jg._validateJavaBinary(jExe).then((v) => {
            loggerLanding.log('Java version meta', v)
            if (v.valid) {
                dlAsync()
            } else {
                asyncSystemScan(mcVersion)
            }
        })
    }
    setLaunchEnabled(false);
})

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc) {
    setOverlayContent(
        title,
        desc,
        'Dismiss'
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

let sysAEx
let scanAt

let extractListener

/**
 * Asynchronously scan the system for valid Java installations.
 *
 * @param {string} mcVersion The Minecraft version we are scanning for.
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
function asyncSystemScan(mcVersion, launchAfter = true) {

    setLaunchDetails('Please wait..')
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const loggerSysAEx = LoggerUtil('%c[SysAEx]', 'color: #353232; font-weight: bold')

    const forkEnv = JSON.parse(JSON.stringify(process.env))
    forkEnv.CONFIG_DIRECT_PATH = ConfigManager.getLauncherDirectory()

    // Fork a process to run validations.
    sysAEx = cp.fork(path.join(__dirname, 'assets', 'js', 'assetexec.js'), [
        'JavaGuard',
        mcVersion
    ], {
        env: forkEnv,
        stdio: 'pipe'
    })
    // Stdout
    sysAEx.stdio[1].setEncoding('utf8')
    sysAEx.stdio[1].on('data', (data) => {
        loggerSysAEx.log(data)
    })
    // Stderr
    sysAEx.stdio[2].setEncoding('utf8')
    sysAEx.stdio[2].on('data', (data) => {
        loggerSysAEx.log(data)
    })

    sysAEx.on('message', (m) => {

        if (m.context === 'validateJava') {
            if (m.result == null) {
                setLaunchDetails('Preparing Java Download..')
                sysAEx.send({ task: 'changeContext', class: 'AssetGuard', args: [ConfigManager.getCommonDirectory(), ConfigManager.getJavaExecutable()] })
                sysAEx.send({ task: 'execute', function: '_enqueueOpenJDK', argsArr: [ConfigManager.getDataDirectory()] })

            } else {
                // Java installation found, use this to launch the game.
                ConfigManager.setJavaExecutable(m.result)
                ConfigManager.save()

                // We need to make sure that the updated value is on the settings UI.
                // Just incase the settings UI is already open.
                settingsJavaExecVal.value = m.result
                populateJavaExecDetails(settingsJavaExecVal.value)

                if (launchAfter) {
                    dlAsync()
                }
                sysAEx.disconnect()
            }
        } else if (m.context === '_enqueueOpenJDK') {

            if (m.result === true) {

                // Oracle JRE enqueued successfully, begin download.
                setLaunchDetails('Downloading Java..')
                sysAEx.send({ task: 'execute', function: 'processDlQueues', argsArr: [[{ id: 'java', limit: 1 }]] })

            } else {

                // Oracle JRE enqueue failed. Probably due to a change in their website format.
                // User will have to follow the guide to install Java.
                setOverlayContent(
                    'Unexpected Issue:<br>Java Download Failed',
                    'Unfortunately we\'ve encountered an issue while attempting to install Java. You will need to manually install a copy.',
                    'I Understand'
                )
                setOverlayHandler(() => {
                    toggleOverlay(false)
                    toggleLaunchArea(false)
                })
                toggleOverlay(true)
                sysAEx.disconnect()

            }

        } else if (m.context === 'progress') {

            switch (m.data) {
                case 'download':
                    // Downloading..
                    setDownloadPercentage(m.value, m.total, m.percent)
                    break
            }

        } else if (m.context === 'complete') {

            switch (m.data) {
                case 'download': {
                    // Show installing progress bar.
                    remote.getCurrentWindow().setProgressBar(2)

                    // Wait for extration to complete.
                    const eLStr = 'Extracting'
                    let dotStr = ''
                    setLaunchDetails(eLStr)
                    extractListener = setInterval(() => {
                        if (dotStr.length >= 3) {
                            dotStr = ''
                        } else {
                            dotStr += '.'
                        }
                        setLaunchDetails(eLStr + dotStr)
                    }, 750)
                    break
                }
                case 'java':
                    // Download & extraction complete, remove the loading from the OS progress bar.
                    remote.getCurrentWindow().setProgressBar(-1)

                    // Extraction completed successfully.
                    ConfigManager.setJavaExecutable(m.args[0])
                    ConfigManager.save()

                    if (extractListener != null) {
                        clearInterval(extractListener)
                        extractListener = null
                    }

                    setLaunchDetails('Java Installed!')

                    if (launchAfter) {
                        dlAsync()
                    }

                    sysAEx.disconnect()
                    break
            }

        } else if (m.context === 'error') {
            console.log(m.error)
        }
    })

    // Begin system Java scan.
    setLaunchDetails('Checking system info..')
    sysAEx.send({ task: 'execute', function: 'validateJava', argsArr: [ConfigManager.getDataDirectory()] })
}

// Keep reference to Minecraft Process
let proc

let aEx
let versionData

let progressListener

function dlAsync() {

    setLaunchDetails('Please wait..')
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const loggerAEx = LoggerUtil('%c[AEx]', 'color: #353232; font-weight: bold')
    const loggerLaunchSuite = LoggerUtil('%c[LaunchSuite]', 'color: #000668; font-weight: bold')

    const forkEnv = JSON.parse(JSON.stringify(process.env))
    forkEnv.CONFIG_DIRECT_PATH = ConfigManager.getLauncherDirectory()

    // Start AssetExec to run validations and downloads in a forked process.
    aEx = cp.fork(path.join(__dirname, 'assets', 'js', 'assetexec.js'), [
        'AssetGuard',
        ConfigManager.getCommonDirectory(),
        ConfigManager.getJavaExecutable()
    ], {
        env: forkEnv,
        stdio: 'pipe'
    })
    // Stdout
    aEx.stdio[1].setEncoding('utf8')
    // Stderr
    aEx.stdio[2].setEncoding('utf8')
    aEx.stdio[2].on('data', (data) => {
        loggerAEx.log(data)
    })
    aEx.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure('Error During Launch', err.message || 'See console (CTRL + Shift + i) for more details.')
    })
    aEx.on('close', (code, signal) => {
        if (code !== 0) {
            loggerLaunchSuite.error(`AssetExec exited with code ${code}, assuming error.`)
            showLaunchFailure('Error During Launch', 'See console (CTRL + Shift + i) for more details.')
        }
    })

    // Establish communications between the AssetExec and current process.
    aEx.on('message', (m) => {

        if (m.context === 'validate') {
            switch (m.data) {
                case 'version':
                    setLaunchPercentage(25, 100)
                    loggerLaunchSuite.log('Version data loaded.')
                    setLaunchDetails('Validating asset integrity..')
                    break
                case 'assets':
                    setLaunchPercentage(50, 100)
                    loggerLaunchSuite.log('Asset Validation Complete')
                    setLaunchDetails('Validating library integrity..')
                    break
                case 'libraries':
                    setLaunchPercentage(75, 100)
                    loggerLaunchSuite.log('Library validation complete.')
                    setLaunchDetails('Validating miscellaneous file integrity..')
                    break
                case 'files':
                    setLaunchPercentage(100, 100)
                    loggerLaunchSuite.log('File validation complete.')
                    setLaunchDetails('Downloading files..')
                    break
            }
        } else if (m.context === 'progress') {
            switch (m.data) {
                case 'assets': {
                    const perc = (m.value / m.total) * 20
                    setLaunchPercentage(40 + perc, 100, parseInt(40 + perc))
                    break
                }
                case 'download':
                    setDownloadPercentage(m.value, m.total, m.percent)
                    break
                case 'extract': {
                    // Show installing progress bar.
                    remote.getCurrentWindow().setProgressBar(2)

                    // Download done, extracting.
                    const eLStr = 'Extracting libraries'
                    let dotStr = ''
                    setLaunchDetails(eLStr)
                    progressListener = setInterval(() => {
                        if (dotStr.length >= 3) {
                            dotStr = ''
                        } else {
                            dotStr += '.'
                        }
                        setLaunchDetails(eLStr + dotStr)
                    }, 750)
                    break
                }
            }
        } else if (m.context === 'complete') {
            switch (m.data) {
                case 'download':
                    // Download and extraction complete, remove the loading from the OS progress bar.
                    remote.getCurrentWindow().setProgressBar(-1)
                    if (progressListener != null) {
                        clearInterval(progressListener)
                        progressListener = null
                    }

                    setLaunchDetails('Preparing to launch..')
                    break
            }
        } else if (m.context === 'error') {
            switch (m.data) {
                case 'download':
                    loggerLaunchSuite.error('Error while downloading:', m.error)

                    if (m.error.code === 'ENOENT') {
                        showLaunchFailure(
                            'Download Error',
                            'Could not connect to the file server. Ensure that you are connected to the internet and try again.'
                        )
                    } else {
                        showLaunchFailure(
                            'Download Error',
                            'Check the console (CTRL + Shift + i) for more details. Please try again.'
                        )
                    }

                    remote.getCurrentWindow().setProgressBar(-1)

                    // Disconnect from AssetExec
                    aEx.disconnect()
                    break
            }
        } else if(m.context === 'validateEverything') {

            let allGood = true

            // If these properties are not defined it's likely an error.
            if (m.result.versionData == null){
                loggerLaunchSuite.error('Error during validation:', m.result)

                loggerLaunchSuite.error('Error during launch', m.result.error)
                showLaunchFailure('Error During Launch', 'Please check the console (CTRL + Shift + i) for more details.')

                allGood = false
            }

            versionData = m.result.versionData

            if (allGood) {

                let mcArgs = [
                    '--username', '${auth_player_name}',
                    '--version', '${version_name}',
                    '--gameDir', '${game_directory}',
                    '--assetsDir', '${assets_root}',
                    '--assetIndex', '${assets_index_name}',
                    '--uuid', '${auth_uuid}',
                    '--accessToken', '${auth_access_token}',
                    '--userProperties', '${user_properties}',
                    '--userType', '${user_type}'
                ].join(" ")

                let pb = new ProcessBuilder(versionData, mcArgs)
                setLaunchDetails('Launching game..')

                const gameStateChange = function(data){
                    data = data.toString().trim()

                    if (/#@!@# Game crashed! Crash report saved to: #@!@#/g.test(data)) {
                        launch_button.childNodes[1].childNodes[3].textContent = "Launch";
                        remote.getCurrentWindow().show()

                        let fileLoc = data.split('#@!@# Game crashed! Crash report saved to: #@!@#')[1].trim()

                        let fileData = require('fs').readFileSync(fileLoc).toString()

                        require('axios').post('https://paste.crystaldev.co/documents', fileData)
                            .then(d => {
                                let crashLog = `https://paste.crystaldev.co/${d.data.key}`

                                let stackTraceRegexp = /(.+)(\r\n\tat.+)+/

                                if (stackTraceRegexp.test(fileData)) {
                                    showLaunchFailure(
                                        'Game Crash Detected',
                                        `<pre style="padding: 8px; text-align: justify; background: rgba(43,43,43,0.4);"><code style="display: block">${fileData.match(stackTraceRegexp)[0]}</code></pre><a href="${crashLog}">View Crash Report</a>`,
                                    )
                                } else {
                                    showLaunchFailure(
                                        'Game Crash Detected',
                                        `${stackTraceRegexp.test(fileData) ? fileData.match(stackTraceRegexp)[0] : 'A crash has been detected during runtime'}<h1><a href="${crashLog}">Crash Log</a></h1>`,
                                    )
                                }
                            })
                    }
                    else if (new RegExp("^.+ \\[Client thread/INFO\]: Stopping!$").test(data)) {
                        launch_button.childNodes[1].childNodes[3].textContent = "Launch";
                        setLaunchEnabled(true);
                        remote.getCurrentWindow().show()
                    }
                }

                const gameErrorListener = function(data) {
                    data = data.trim()

                    if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                        remote.getCurrentWindow().show()
                        launch_button.childNodes[1].childNodes[3].textContent = "Launch";
                        loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                        showLaunchFailure('Error During Launch', 'The main file, LaunchWrapper, failed to download properly. As a result, the game cannot launch.<br><br>To fix this issue, temporarily turn off your antivirus software and launch the game again.<br><br>If you have time, please <a href="https://github.com/dscalzi/HeliosLauncher/issues">submit an issue</a> and let us know what antivirus software you use. We\'ll contact them and try to straighten things out.')
                    }
                }

                try {
                    // Build Minecraft process.
                    proc = pb.build()
                    launch_button.childNodes[1].childNodes[3].textContent = "Running"

                    if (ConfigManager.getHideLauncher())
                        remote.getCurrentWindow().hide()

                    // Bind listeners to stdout.
                    proc.stderr.on('data', gameErrorListener)
                    proc.stdout.on('data', gameStateChange)

                } catch(err) {
                    loggerLaunchSuite.error('Error during launch', err)
                    showLaunchFailure('Error During Launch', 'Please check the console (CTRL + Shift + i) for more details.')
                }
            }

            // Disconnect from AssetExec
            aEx.disconnect()
        }
    })

    setLaunchDetails('Loading server information..')
    aEx.send({ task: 'execute', function: 'validateEverything', argsArr: [] })
}