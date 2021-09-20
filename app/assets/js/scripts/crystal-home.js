const https = require('https')
const axios = require('axios')

// NAV BAR

$("#nav #store").on("click", function () {
    shell.openExternal($(this).data("src"));
});

$("#nav #home").on("click", function () {
    saveSettingsValues()
    ConfigManager.save()

    switchView(getCurrentView(), VIEWS.landing);
});

$("#nav #settings").on("click", function () {
    switchView(getCurrentView(), VIEWS.settings);
});

$("#back_button").on("click", function () {
    switchView(getCurrentView(), VIEWS.settings);
});

//Setup the partners / servers
axios.get("https://libraries.crystaldev.co/partners.json")
    .then(data => {
        for (const partner of data.data.partners) {
            $("#servers-container").append(
                `
                <a href="${partner.url}" data-balloon-length="medium" aria-label="${partner.ip}" data-balloon-pos="left">
                    <div class="relative rounded-full p-2 shadow-lg">
                        <img src="${partner.logo}" alt="${partner.name}" class="w-14 rounded-full">
                        <span class="absolute h-3 w-3 bottom-1 right-1 rounded-full bg-green-400 hidden"></span>
                    </div>
                </a>
                `
            )
        }
    });

//Setup the news
axios.get("https://libraries.crystaldev.co/news.json")
    .then(data => {
        for (const n of data.data.news) {
            $("#news-container").append(
                `<div class="w-80 shadow-md">
                <img src="${n.image}" class="rounded-t-lg">
                <div class="bg-primary color-gray-2 font-medium text-sm py-5 px-3 rounded-b-lg">
                    ${n.title}
                    <div class="mt-4">
                        <a href="${n.url}">                        
                            <button class="w-full news-btn outline-none uppercase text-sm px-4 py-2 rounded-lg focus:outline-none transition-all">
                                Read more
                            </button>
                        </a>
                    </div>
                </div>
            </div>`
            )
        }
    });

function saveSettingsValues() {
    const sEls = document.getElementById('settingsContainer').querySelectorAll('[cValue]')
    Array.from(sEls).map((v, index, arr) => {
        const cVal = v.getAttribute('cValue')
        const sFn = ConfigManager['set' + cVal]
        if (typeof sFn === 'function') {
            if (v.tagName === 'INPUT') {
                if (v.type === 'number' || v.type === 'text') {
                    // Special Conditions
                    if (cVal === 'JVMOptions') {
                        sFn(v.value.split(' '))
                    } else {
                        sFn(v.value)
                    }
                } else if (v.type === 'checkbox') {
                    sFn(v.checked)
                }
            } else if (v.tagName === 'DIV') {
                if (v.classList.contains('rangeSlider')) {
                    // Special Conditions
                    if (cVal === 'MinRAM' || cVal === 'MaxRAM') {
                        let val = Number(v.getAttribute('value'))
                        if (val % 1 > 0) {
                            val = val * 1000 + 'M'
                        } else {
                            val = val + 'G'
                        }

                        sFn(val)
                    } else {
                        sFn(v.getAttribute('value'))
                    }
                }
            }
        }
    })
}