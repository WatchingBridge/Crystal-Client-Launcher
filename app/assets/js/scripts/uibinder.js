/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const path = require('path')

const ConfigManager = require('./assets/js/configmanager')
const Lang = require('./assets/js/langloader')

let rscShouldLoad = false

// Mapping of each view to their container IDs.
const VIEWS = {
    landing: '#landingContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
}

// The currently shown view container.
let currentView

/**
 * Switch launcher views.
 * 
 * @param {string} current The ID of the current view container. 
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
function switchView(current, next, currentFadeTime = 200, nextFadeTime = 200, onCurrentFade = () => { }, onNextFade = () => { }) {
    currentView = next

    if (next == "#settingsContainer" || next == "#landingContainer") {
        $("#servers-holder").fadeIn(nextFadeTime);
    } else {
        $("#servers-holder").fadeOut(currentFadeTime);
    }

    $(`${current}`).fadeOut(currentFadeTime, () => {
        onCurrentFade()
        $(`${next}`).fadeIn(nextFadeTime, () => {
            onNextFade()
        })
    })
}

/**
 * Get the currently shown view container.
 * 
 * @returns {string} The currently shown view container.
 */
function getCurrentView() {
    return currentView
}

function showMainUI() {
    prepareSettings(true)
    // refreshServerStatus()
    setTimeout(() => {
        $('#main').show()
        currentView = VIEWS.landing
        $(VIEWS.landing).fadeIn(200)
        $("#servers-holder").fadeIn(200)
    }, 750)
}

// Synchronous Listener
document.addEventListener('readystatechange', function () {

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        rscShouldLoad = false
        showMainUI()
    }

}, false)
