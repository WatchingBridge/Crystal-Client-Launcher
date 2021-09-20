// Requirements
const AdmZip        = require('adm-zip')
const async         = require('async')
const axios         = require('axios')
const child_process = require('child_process')
const crypto        = require('crypto')
const EventEmitter  = require('events')
const fs            = require('fs-extra')
const path          = require('path')
const tar           = require('tar-fs')
const zlib          = require('zlib')

const ConfigManager = require('./configmanager')
const isDev         = require('./isdev')
const Registry = require('winreg')



/** Class representing a base asset. */
class Asset {
    /**
     * Create an asset.
     *
     * @param {any} id The id of the asset.
     * @param {string} hash The hash value of the asset.
     * @param {number} size The size in bytes of the asset.
     * @param {string} from The url where the asset can be found.
     * @param {string} to The absolute local file path of the asset.
     */
    constructor(id, hash, size, from, to){
        this.id = id
        this.hash = hash
        this.size = size
        this.from = from
        this.to = to
    }
}

/** Class representing a mojang library. */
class Library extends Asset {

    /**
     * Converts the process.platform OS names to match mojang's OS names.
     */
    static mojangFriendlyOS(){
        const opSys = process.platform
        if (opSys === 'darwin') {
            return 'osx'
        } else if (opSys === 'win32'){
            return 'windows'
        } else if (opSys === 'linux'){
            return 'linux'
        } else {
            return 'unknown_os'
        }
    }

    /**
     * Checks whether or not a library is valid for download on a particular OS, following
     * the rule format specified in the mojang version data index. If the allow property has
     * an OS specified, then the library can ONLY be downloaded on that OS. If the disallow
     * property has instead specified an OS, the library can be downloaded on any OS EXCLUDING
     * the one specified.
     *
     * If the rules are undefined, the natives property will be checked for a matching entry
     * for the current OS.
     *
     * @param {Array.<Object>} rules The Library's download rules.
     * @param {Object} natives The Library's natives object.
     * @returns {boolean} True if the Library follows the specified rules, otherwise false.
     */
    static validateRules(rules, natives){
        if(rules == null) {
            if(natives == null) {
                return true
            } else {
                return natives[Library.mojangFriendlyOS()] != null
            }
        }

        for(let rule of rules){
            const action = rule.action
            const osProp = rule.os
            if(action != null && osProp != null){
                const osName = osProp.name
                const osMoj = Library.mojangFriendlyOS()
                if(action === 'allow'){
                    return osName === osMoj
                } else if(action === 'disallow'){
                    return osName !== osMoj
                }
            }
        }
        return true
    }
}

/**
 * Class representing a download tracker. This is used to store meta data
 * about a download queue, including the queue itself.
 */
class DLTracker {

    /**
     * Create a DLTracker
     *
     * @param {Array.<Asset>} dlqueue An array containing assets queued for download.
     * @param {number} dlsize The combined size of each asset in the download queue array.
     * @param {function(Asset)} callback Optional callback which is called when an asset finishes downloading.
     */
    constructor(dlqueue, dlsize, callback = null){
        this.dlqueue = dlqueue
        this.dlsize = dlsize
        this.callback = callback
    }

}

class Util {

    /**
     * Returns true if the actual version is greater than
     * or equal to the desired version.
     *
     * @param {string} desired The desired version.
     * @param {string} actual The actual version.
     */
    static mcVersionAtLeast(desired, actual){
        const des = desired.split('.')
        const act = actual.split('.')

        for(let i=0; i<des.length; i++){
            if(!(parseInt(act[i]) >= parseInt(des[i]))){
                return false
            }
        }
        return true
    }

}


class JavaGuard extends EventEmitter {

    constructor(mcVersion){
        super()
        this.mcVersion = mcVersion
    }

    /**
     * @typedef OpenJDKData
     * @property {string} uri The base uri of the JRE.
     * @property {number} size The size of the download.
     * @property {string} name The name of the artifact.
     */

    /**
     * Fetch the last open JDK binary.
     *
     * HOTFIX: Uses Corretto 8 for macOS.
     * See: https://github.com/dscalzi/HeliosLauncher/issues/70
     * See: https://github.com/AdoptOpenJDK/openjdk-support/issues/101
     *
     * @param {string} major The major version of Java to fetch.
     *
     * @returns {Promise.<OpenJDKData>} Promise which resolved to an object containing the JRE download data.
     */
    static _latestOpenJDK(major = '8'){
        if(process.platform === 'darwin') {
            return this._latestCorretto(major)
        } else {
            return this._latestAdoptOpenJDK(major)
        }
    }

    static _latestAdoptOpenJDK(major) {

        const sanitizedOS = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'mac' : process.platform)

        const url = `https://api.adoptopenjdk.net/v2/latestAssets/nightly/openjdk${major}?os=${sanitizedOS}&arch=x64&heap_size=normal&openjdk_impl=hotspot&type=jre`

        return new Promise(async (resolve, reject) => {
            let req = await axios.get(url)
                .catch(err => resolve(null));

            if (req.data.length > 0) {
                resolve({
                    uri: req.data[0].binary_link,
                    size: req.data[0].binary_size,
                    name: req.data[0].binary_name
                })
            }
            else resolve(null)
        })
    }

    static _latestCorretto(major) {

        let sanitizedOS, ext

        switch(process.platform) {
            case 'win32':
                sanitizedOS = 'windows'
                ext = 'zip'
                break
            case 'darwin':
                sanitizedOS = 'macos'
                ext = 'tar.gz'
                break
            case 'linux':
                sanitizedOS = 'linux'
                ext = 'tar.gz'
                break
            default:
                sanitizedOS = process.platform
                ext = 'tar.gz'
                break
        }

        const url = `https://corretto.aws/downloads/latest/amazon-corretto-${major}-x64-${sanitizedOS}-jdk.${ext}`

        return new Promise(async (resolve, reject) => {
            let req = await axios.head(url)
                .catch(err => resolve(null))

            if (req.status === 200){
                resolve({
                    uri: url,
                    size: parseInt(req.headers['content-length']),
                    name: url.substr(url.lastIndexOf('/') + 1)
                })
            } else {
                resolve(null)
            }
        })

    }

    /**
     * Returns the path of the OS-specific executable for the given Java
     * installation. Supported OS's are win32, darwin, linux.
     *
     * @param {string} rootDir The root directory of the Java installation.
     * @returns {string} The path to the Java executable.
     */
    static javaExecFromRoot(rootDir){
        if(process.platform === 'win32'){
            return path.join(rootDir, 'bin', 'javaw.exe')
        } else if(process.platform === 'darwin'){
            return path.join(rootDir, 'Contents', 'Home', 'bin', 'java')
        } else if(process.platform === 'linux'){
            return path.join(rootDir, 'bin', 'java')
        }
        return rootDir
    }

    /**
     * Check to see if the given path points to a Java executable.
     *
     * @param {string} pth The path to check against.
     * @returns {boolean} True if the path points to a Java executable, otherwise false.
     */
    static isJavaExecPath(pth){
        if(process.platform === 'win32'){
            return pth.endsWith(path.join('bin', 'javaw.exe'))
        } else if(process.platform === 'darwin'){
            return pth.endsWith(path.join('bin', 'java'))
        } else if(process.platform === 'linux'){
            return pth.endsWith(path.join('bin', 'java'))
        }
        return false
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Dynamically detects the formatting
     * to use.
     *
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static parseJavaRuntimeVersion(verString){
        const major = verString.split('.')[0]
        if(major == 1){
            return JavaGuard._parseJavaRuntimeVersion_8(verString)
        } else {
            return JavaGuard._parseJavaRuntimeVersion_9(verString)
        }
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Uses Java 8 formatting.
     *
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static _parseJavaRuntimeVersion_8(verString){
        // 1.{major}.0_{update}-b{build}
        // ex. 1.8.0_152-b16
        const ret = {}
        let pts = verString.split('-')
        ret.build = parseInt(pts[1].substring(1))
        pts = pts[0].split('_')
        ret.update = parseInt(pts[1])
        ret.major = parseInt(pts[0].split('.')[1])
        return ret
    }

    /**
     * Parses a **full** Java Runtime version string and resolves
     * the version information. Uses Java 9+ formatting.
     *
     * @param {string} verString Full version string to parse.
     * @returns Object containing the version information.
     */
    static _parseJavaRuntimeVersion_9(verString){
        // {major}.{minor}.{revision}+{build}
        // ex. 10.0.2+13
        const ret = {}
        let pts = verString.split('+')
        ret.build = parseInt(pts[1])
        pts = pts[0].split('.')
        ret.major = parseInt(pts[0])
        ret.minor = parseInt(pts[1])
        ret.revision = parseInt(pts[2])
        return ret
    }

    /**
     * Validates the output of a JVM's properties. Currently validates that a JRE is x64
     * and that the major = 8, update > 52.
     *
     * @param {string} stderr The output to validate.
     *
     * @returns {Promise.<Object>} A promise which resolves to a meta object about the JVM.
     * The validity is stored inside the `valid` property.
     */
    _validateJVMProperties(stderr){
        const res = stderr
        const props = res.split('\n')

        const goal = 2
        let checksum = 0

        const meta = {}

        for(let i=0; i<props.length; i++){
            if(props[i].indexOf('sun.arch.data.model') > -1){
                let arch = props[i].split('=')[1].trim()
                arch = parseInt(arch)
                console.log(props[i].trim())
                if(arch === 64){
                    meta.arch = arch
                    ++checksum
                    if(checksum === goal){
                        break
                    }
                }
            } else if (props[i].indexOf('java.runtime.version') > -1){
                let verString = props[i].split('=')[1].trim()
                console.log(props[i].trim())
                const verOb = JavaGuard.parseJavaRuntimeVersion(verString)
                if (verOb.major === 8 && verOb.update > 52) {
                    meta.version = verOb
                    ++checksum
                    if(checksum === goal){
                        break
                    }
                }
                // Space included so we get only the vendor.
            } else if(props[i].lastIndexOf('java.vendor ') > -1) {
                let vendorName = props[i].split('=')[1].trim()
                console.log(props[i].trim())
                meta.vendor = vendorName
            }
        }

        meta.valid = checksum === goal

        return meta
    }

    /**
     * Validates that a Java binary is at least 64 bit. This makes use of the non-standard
     * command line option -XshowSettings:properties. The output of this contains a property,
     * sun.arch.data.model = ARCH, in which ARCH is either 32 or 64. This option is supported
     * in Java 8 and 9. Since this is a non-standard option. This will resolve to true if
     * the function's code throws errors. That would indicate that the option is changed or
     * removed.
     *
     * @param {string} binaryExecPath Path to the java executable we wish to validate.
     *
     * @returns {Promise.<Object>} A promise which resolves to a meta object about the JVM.
     * The validity is stored inside the `valid` property.
     */
    _validateJavaBinary(binaryExecPath){

        return new Promise((resolve, reject) => {
            if(!JavaGuard.isJavaExecPath(binaryExecPath)){
                resolve({valid: false})
            } else if(fs.existsSync(binaryExecPath)){
                // Workaround (javaw.exe no longer outputs this information.)
                console.log(typeof binaryExecPath)
                if(binaryExecPath.indexOf('javaw.exe') > -1) {
                    binaryExecPath.replace('javaw.exe', 'java.exe')
                }
                child_process.exec('"' + binaryExecPath + '" -XshowSettings:properties', (err, stdout, stderr) => {
                    try {
                        // Output is stored in stderr?
                        resolve(this._validateJVMProperties(stderr))
                    } catch (err){
                        // Output format might have changed, validation cannot be completed.
                        resolve({valid: false})
                    }
                })
            } else {
                resolve({valid: false})
            }
        })

    }

    /**
     * Checks for the presence of the environment variable JAVA_HOME. If it exits, we will check
     * to see if the value points to a path which exists. If the path exits, the path is returned.
     *
     * @returns {string} The path defined by JAVA_HOME, if it exists. Otherwise null.
     */
    static _scanJavaHome(){
        const jHome = process.env.JAVA_HOME
        try {
            let res = fs.existsSync(jHome)
            return res ? jHome : null
        } catch (err) {
            // Malformed JAVA_HOME property.
            return null
        }
    }

    /**
     * Scans the registry for 64-bit Java entries. The paths of each entry are added to
     * a set and returned. Currently, only Java 8 (1.8) is supported.
     *
     * @returns {Promise.<Set.<string>>} A promise which resolves to a set of 64-bit Java root
     * paths found in the registry.
     */
    static _scanRegistry(){

        return new Promise((resolve, reject) => {
            // Keys for Java v9.0.0 and later:
            // 'SOFTWARE\\JavaSoft\\JRE'
            // 'SOFTWARE\\JavaSoft\\JDK'
            // Forge does not yet support Java 9, therefore we do not.

            // Keys for Java 1.8 and prior:
            const regKeys = [
                '\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
                '\\SOFTWARE\\JavaSoft\\Java Development Kit'
            ]

            let keysDone = 0

            const candidates = new Set()

            for(let i=0; i<regKeys.length; i++){
                const key = new Registry({
                    hive: Registry.HKLM,
                    key: regKeys[i],
                    arch: 'x64'
                })
                key.keyExists((err, exists) => {
                    if(exists) {
                        key.keys((err, javaVers) => {
                            if(err){
                                keysDone++
                                console.error(err)

                                // REG KEY DONE
                                // DUE TO ERROR
                                if(keysDone === regKeys.length){
                                    resolve(candidates)
                                }
                            } else {
                                if(javaVers.length === 0){
                                    // REG KEY DONE
                                    // NO SUBKEYS
                                    keysDone++
                                    if(keysDone === regKeys.length){
                                        resolve(candidates)
                                    }
                                } else {

                                    let numDone = 0

                                    for(let j=0; j<javaVers.length; j++){
                                        const javaVer = javaVers[j]
                                        const vKey = javaVer.key.substring(javaVer.key.lastIndexOf('\\')+1)
                                        // Only Java 8 is supported currently.
                                        if(parseFloat(vKey) === 1.8){
                                            javaVer.get('JavaHome', (err, res) => {
                                                const jHome = res.value
                                                if(jHome.indexOf('(x86)') === -1){
                                                    candidates.add(jHome)
                                                }

                                                // SUBKEY DONE

                                                numDone++
                                                if(numDone === javaVers.length){
                                                    keysDone++
                                                    if(keysDone === regKeys.length){
                                                        resolve(candidates)
                                                    }
                                                }
                                            })
                                        } else {

                                            // SUBKEY DONE
                                            // NOT JAVA 8

                                            numDone++
                                            if(numDone === javaVers.length){
                                                keysDone++
                                                if(keysDone === regKeys.length){
                                                    resolve(candidates)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        })
                    } else {

                        // REG KEY DONE
                        // DUE TO NON-EXISTANCE

                        keysDone++
                        if(keysDone === regKeys.length){
                            resolve(candidates)
                        }
                    }
                })
            }

        })

    }

    /**
     * See if JRE exists in the Internet Plug-Ins folder.
     *
     * @returns {string} The path of the JRE if found, otherwise null.
     */
    static _scanInternetPlugins(){
        // /Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java
        const pth = '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin'
        const res = fs.existsSync(JavaGuard.javaExecFromRoot(pth))
        return res ? pth : null
    }

    /**
     * Scan a directory for root JVM folders.
     *
     * @param {string} scanDir The directory to scan.
     * @returns {Promise.<Set.<string>>} A promise which resolves to a set of the discovered
     * root JVM folders.
     */
    static async _scanFileSystem(scanDir){

        let res = new Set()

        if(await fs.pathExists(scanDir)) {

            const files = await fs.readdir(scanDir)
            for(let i=0; i<files.length; i++){

                const combinedPath = path.join(scanDir, files[i])
                const execPath = JavaGuard.javaExecFromRoot(combinedPath)

                if(await fs.pathExists(execPath)) {
                    res.add(combinedPath)
                }
            }
        }

        return res

    }

    /**
     *
     * @param {Set.<string>} rootSet A set of JVM root strings to validate.
     * @returns {Promise.<Object[]>} A promise which resolves to an array of meta objects
     * for each valid JVM root directory.
     */
    async _validateJavaRootSet(rootSet){

        const rootArr = Array.from(rootSet)
        const validArr = []

        for(let i=0; i<rootArr.length; i++){

            const execPath = JavaGuard.javaExecFromRoot(rootArr[i])
            const metaOb = await this._validateJavaBinary(execPath)

            if(metaOb.valid){
                metaOb.execPath = execPath
                validArr.push(metaOb)
            }

        }

        return validArr

    }

    /**
     * Sort an array of JVM meta objects. Best candidates are placed before all others.
     * Sorts based on version and gives priority to JREs over JDKs if versions match.
     *
     * @param {Object[]} validArr An array of JVM meta objects.
     * @returns {Object[]} A sorted array of JVM meta objects.
     */
    static _sortValidJavaArray(validArr){
        const retArr = validArr.sort((a, b) => {

            if(a.version.major === b.version.major){

                if(a.version.major < 9){
                    // Java 8
                    if(a.version.update === b.version.update){
                        if(a.version.build === b.version.build){

                            // Same version, give priority to JRE.
                            if(a.execPath.toLowerCase().indexOf('jdk') > -1){
                                return b.execPath.toLowerCase().indexOf('jdk') > -1 ? 0 : 1
                            } else {
                                return -1
                            }

                        } else {
                            return a.version.build > b.version.build ? -1 : 1
                        }
                    } else {
                        return  a.version.update > b.version.update ? -1 : 1
                    }
                } else {
                    // Java 9+
                    if(a.version.minor === b.version.minor){
                        if(a.version.revision === b.version.revision){

                            // Same version, give priority to JRE.
                            if(a.execPath.toLowerCase().indexOf('jdk') > -1){
                                return b.execPath.toLowerCase().indexOf('jdk') > -1 ? 0 : 1
                            } else {
                                return -1
                            }

                        } else {
                            return a.version.revision > b.version.revision ? -1 : 1
                        }
                    } else {
                        return  a.version.minor > b.version.minor ? -1 : 1
                    }
                }

            } else {
                return a.version.major > b.version.major ? -1 : 1
            }
        })

        return retArr
    }

    /**
     * Attempts to find a valid x64 installation of Java on Windows machines.
     * Possible paths will be pulled from the registry and the JAVA_HOME environment
     * variable. The paths will be sorted with higher versions preceeding lower, and
     * JREs preceeding JDKs. The binaries at the sorted paths will then be validated.
     * The first validated is returned.
     *
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     *
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid
     * x64 Java installation. If none are found, null is returned.
     */
    async _win32JavaValidate(dataDir){

        // Get possible paths from the registry.
        let pathSet1 = await JavaGuard._scanRegistry()
        if(pathSet1.size === 0){
            // Do a manual file system scan of program files.
            pathSet1 = new Set([
                ...pathSet1,
                ...(await JavaGuard._scanFileSystem('C:\\Program Files\\Java')),
                ...(await JavaGuard._scanFileSystem('C:\\Program Files\\AdoptOpenJDK'))
            ])
        }

        // Get possible paths from the data directory.
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))

        // Merge the results.
        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Validate JAVA_HOME.
        const jHome = JavaGuard._scanJavaHome()
        if(jHome != null && jHome.indexOf('(x86)') === -1){
            uberSet.add(jHome)
        }

        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }

    }

    /**
     * Attempts to find a valid x64 installation of Java on MacOS.
     * The system JVM directory is scanned for possible installations.
     * The JAVA_HOME enviroment variable and internet plugins directory
     * are also scanned and validated.
     *
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     *
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid
     * x64 Java installation. If none are found, null is returned.
     */
    async _darwinJavaValidate(dataDir){

        const pathSet1 = await JavaGuard._scanFileSystem('/Library/Java/JavaVirtualMachines')
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))

        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Check Internet Plugins folder.
        const iPPath = JavaGuard._scanInternetPlugins()
        if(iPPath != null){
            uberSet.add(iPPath)
        }

        // Check the JAVA_HOME environment variable.
        let jHome = JavaGuard._scanJavaHome()
        if(jHome != null){
            // Ensure we are at the absolute root.
            if(jHome.contains('/Contents/Home')){
                jHome = jHome.substring(0, jHome.indexOf('/Contents/Home'))
            }
            uberSet.add(jHome)
        }

        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }
    }

    /**
     * Attempts to find a valid x64 installation of Java on Linux.
     * The system JVM directory is scanned for possible installations.
     * The JAVA_HOME enviroment variable is also scanned and validated.
     *
     * Higher versions > Lower versions
     * If versions are equal, JRE > JDK.
     *
     * @param {string} dataDir The base launcher directory.
     * @returns {Promise.<string>} A Promise which resolves to the executable path of a valid
     * x64 Java installation. If none are found, null is returned.
     */
    async _linuxJavaValidate(dataDir){

        const pathSet1 = await JavaGuard._scanFileSystem('/usr/lib/jvm')
        const pathSet2 = await JavaGuard._scanFileSystem(path.join(dataDir, 'runtime', 'x64'))

        const uberSet = new Set([...pathSet1, ...pathSet2])

        // Validate JAVA_HOME
        const jHome = JavaGuard._scanJavaHome()
        if(jHome != null){
            uberSet.add(jHome)
        }

        let pathArr = await this._validateJavaRootSet(uberSet)
        pathArr = JavaGuard._sortValidJavaArray(pathArr)

        if(pathArr.length > 0){
            return pathArr[0].execPath
        } else {
            return null
        }
    }

    /**
     * Retrieve the path of a valid x64 Java installation.
     *
     * @param {string} dataDir The base launcher directory.
     * @returns {string} A path to a valid x64 Java installation, null if none found.
     */
    async validateJava(dataDir){
        return await this['_' + process.platform + 'JavaValidate'](dataDir)
    }

}




/**
 * Central object class used for control flow. This object stores data about
 * categories of downloads. Each category is assigned an identifier with a
 * DLTracker object as its value. Combined information is also stored, such as
 * the total size of all the queued files in each category. This event is used
 * to emit events so that external modules can listen into processing done in
 * this module.
 */
class AssetGuard extends EventEmitter {

    /**
     * Create an instance of AssetGuard.
     * On creation the object's properties are never-null default
     * values. Each identifier is resolved to an empty DLTracker.
     *
     * @param {string} commonPath The common path for shared game files.
     * @param {string} javaexec The path to a java executable which will be used
     * to finalize installation.
     */
    constructor(commonPath, javaexec){
        super()
        this.totaldlsize = 0
        this.progress = 0
        this.assets = new DLTracker([], 0)
        this.libraries = new DLTracker([], 0)
        this.files = new DLTracker([], 0)
        this.forge = new DLTracker([], 0)
        this.java = new DLTracker([], 0)
        this.extractQueue = []
        this.commonPath = commonPath
        this.javaexec = javaexec
    }

    // Static Utility Functions
    // #region

    // Static Hash Validation Functions
    // #region

    /**
     * Calculates the hash for a file using the specified algorithm.
     *
     * @param {Buffer} buf The buffer containing file data.
     * @param {string} algo The hash algorithm.
     * @returns {string} The calculated hash in hex.
     */
    static _calculateHash(buf, algo){
        return crypto.createHash(algo).update(buf).digest('hex')
    }

    /**
     * Validate that a file exists and matches a given hash value.
     *
     * @param {string} filePath The path of the file to validate.
     * @param {string} algo The hash algorithm to check against.
     * @param {string} hash The existing hash to check against.
     * @returns {boolean} True if the file exists and calculated hash matches the given hash, otherwise false.
     */
    static _validateLocal(filePath, algo, hash){
        if(fs.existsSync(filePath)){
            //No hash provided, have to assume it's good.
            if(hash == null){
                return true
            }
            let buf = fs.readFileSync(filePath)
            let calcdhash = AssetGuard._calculateHash(buf, algo)
            return calcdhash === hash.toLowerCase()
        }
        return false
    }

    // #endregion

    // Miscellaneous Static Functions
    // #region

    /**
     * Extracts and unpacks a file from .pack.xz format.
     *
     * @param {Array.<string>} filePaths The paths of the files to be extracted and unpacked.
     * @returns {Promise.<void>} An empty promise to indicate the extraction has completed.
     */
    static _extractPackXZ(filePaths, javaExecutable){
        console.log('[PackXZExtract] Starting')
        return new Promise((resolve, reject) => {

            let libPath
            if(isDev){
                libPath = path.join(process.cwd(), 'libraries', 'java', 'PackXZExtract.jar')
            } else {
                if(process.platform === 'darwin'){
                    libPath = path.join(process.cwd(),'Contents', 'Resources', 'libraries', 'java', 'PackXZExtract.jar')
                } else {
                    libPath = path.join(process.cwd(), 'resources', 'libraries', 'java', 'PackXZExtract.jar')
                }
            }

            const filePath = filePaths.join(',')
            const child = child_process.spawn(javaExecutable, ['-jar', libPath, '-packxz', filePath])
            child.stdout.on('data', (data) => {
                console.log('[PackXZExtract]', data.toString('utf8'))
            })
            child.stderr.on('data', (data) => {
                console.log('[PackXZExtract]', data.toString('utf8'))
            })
            child.on('close', (code, signal) => {
                console.log('[PackXZExtract]', 'Exited with code', code)
                resolve()
            })
        })
    }

    // #endregion

    // Validation Functions
    // #region

    /**
     * Loads the version data for a given minecraft version.
     *
     * @param {string} version The game version for which to load the index data.
     * @param {boolean} force Optional. If true, the version index will be downloaded even if it exists locally. Defaults to false.
     * @returns {Promise.<Object>} Promise which resolves to the version data object.
     */
    loadVersionData(version, force = false){
        const self = this
        return new Promise(async (resolve, reject) => {
            const versionPath = path.join(self.commonPath, 'versions', version)
            const versionFile = path.join(versionPath, version + '.json')
            if(!fs.existsSync(versionFile) || force){
                const url = "https://libraries.crystaldev.co/CrystalClient.json"
                console.log('Preparing download of ' + version + ' assets.')
                fs.ensureDirSync(versionPath)

                axios({
                    method: 'GET',
                    url,
                    responseType: 'stream'
                })
                    .then(resp => {
                        const stream = resp.data.pipe(fs.createWriteStream(versionFile))
                        stream.on('finish', () => {
                            resolve(JSON.parse(fs.readFileSync(versionFile).toString()))

                            console.log(fs.readFileSync(versionFile).toString())
                        })
                    })
            } else {
                resolve(JSON.parse(fs.readFileSync(versionFile).toString()))
            }
        })
    }
// Asset (Category=''') Validation Functions
    // #region

    /**
     * Public asset validation function. This function will handle the validation of assets.
     * It will parse the asset index specified in the version data, analyzing each
     * asset entry. In this analysis it will check to see if the local file exists and is valid.
     * If not, it will be added to the download queue for the 'assets' identifier.
     *
     * @param {Object} versionData The version data for the assets.
     * @param {boolean} force Optional. If true, the asset index will be downloaded even if it exists locally. Defaults to false.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateAssets(versionData, force = false){
        const self = this
        return new Promise((resolve, reject) => {
            self._assetChainIndexData(versionData, force).then(() => {
                resolve()
            })
        })
    }

    //Chain the asset tasks to provide full async. The below functions are private.
    /**
     * Private function used to chain the asset validation process. This function retrieves
     * the index data.
     * @param {Object} versionData
     * @param {boolean} force
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    _assetChainIndexData(versionData, force = false){
        const self = this
        return new Promise((resolve, reject) => {
            //Asset index constants.
            const assetIndex = versionData.assetIndex
            const name = assetIndex.id + '.json'
            const indexPath = path.join(self.commonPath, 'assets', 'indexes')
            const assetIndexLoc = path.join(indexPath, name)

            let data = null
            if(!fs.existsSync(assetIndexLoc) || force){
                console.log('Downloading ' + versionData.id + ' asset index.')
                fs.ensureDirSync(indexPath)

                axios({
                    method: 'GET',
                    url: assetIndex.url,
                    responseType: 'stream'
                })
                    .then(resp => {
                        const stream = resp.data.pipe(fs.createWriteStream(assetIndexLoc))
                        stream.on('finish', () => {
                            data = JSON.parse(fs.readFileSync(assetIndexLoc, 'utf-8'))
                            self._assetChainValidateAssets(versionData, data).then(() => {
                                resolve()
                            })
                        })
                    })
            } else {
                data = JSON.parse(fs.readFileSync(assetIndexLoc, 'utf-8'))
                self._assetChainValidateAssets(versionData, data).then(() => {
                    resolve()
                })
            }
        })
    }

    /**
     * Private function used to chain the asset validation process. This function processes
     * the assets and enqueues missing or invalid files.
     * @param {Object} versionData
     * @param {boolean} force
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    _assetChainValidateAssets(versionData, indexData){
        const self = this
        return new Promise((resolve, reject) => {

            //Asset constants
            const resourceURL = 'https://resources.download.minecraft.net/'
            const localPath = path.join(self.commonPath, 'assets')
            const objectPath = path.join(localPath, 'objects')

            const assetDlQueue = []
            let dlSize = 0
            let acc = 0
            const total = Object.keys(indexData.objects).length
            //const objKeys = Object.keys(data.objects)
            async.forEachOfLimit(indexData.objects, 10, (value, key, cb) => {
                acc++
                self.emit('progress', 'assets', acc, total)
                const hash = value.hash
                const assetName = path.join(hash.substring(0, 2), hash)
                const urlName = hash.substring(0, 2) + '/' + hash
                const ast = new Asset(key, hash, value.size, resourceURL + urlName, path.join(objectPath, assetName))
                if(!AssetGuard._validateLocal(ast.to, 'sha1', ast.hash)){
                    dlSize += ast.size
                    assetDlQueue.push(ast)
                }
                cb()
            }, (err) => {
                self.assets = new DLTracker(assetDlQueue, dlSize)
                resolve()
            })
        })
    }

    // #endregion

    // Library (Category=''') Validation Functions
    // #region

    /**
     * Public library validation function. This function will handle the validation of libraries.
     * It will parse the version data, analyzing each library entry. In this analysis, it will
     * check to see if the local file exists and is valid. If not, it will be added to the download
     * queue for the 'libraries' identifier.
     *
     * @param {Object} versionData The version data for the assets.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateLibraries(versionData){
        const self = this
        return new Promise((resolve, reject) => {

            const libArr = versionData.libraries
            const libPath = path.join(self.commonPath, 'libraries')

            const libDlQueue = []
            let dlSize = 0

            //Check validity of each library. If the hashs don't match, download the library.
            async.eachLimit(libArr, 5, (lib, cb) => {
                if(Library.validateRules(lib.rules, lib.natives)){
                    let artifact = (lib.natives == null) ? lib.downloads.artifact : lib.downloads.classifiers[lib.natives[Library.mojangFriendlyOS()].replace('${arch}', process.arch.replace('x', ''))]
                    const libItm = new Library(lib.name, artifact.sha1, artifact.size, artifact.url, path.join(libPath, artifact.path))
                    if(!AssetGuard._validateLocal(libItm.to, 'sha1', libItm.hash)){
                        dlSize += (libItm.size*1)
                        libDlQueue.push(libItm)
                    }
                }
                cb()
            }, (err) => {
                self.libraries = new DLTracker(libDlQueue, dlSize)
                resolve()
            })
        })
    }

    // #endregion

    // Miscellaneous (Category=files) Validation Functions
    // #region

    /**
     * Public miscellaneous mojang file validation function. These files will be enqueued under
     * the 'files' identifier.
     *
     * @param {Object} versionData The version data for the assets.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateMiscellaneous(versionData){
        const self = this
        return new Promise(async (resolve, reject) => {
            await self.validateClient(versionData)
            await self.validateLogConfig(versionData)
            resolve()
        })
    }

    /**
     * Validate client file - artifact renamed from client.jar to '{version}'.jar.
     *
     * @param {Object} versionData The version data for the assets.
     * @param {boolean} force Optional. If true, the asset index will be downloaded even if it exists locally. Defaults to false.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateClient(versionData, force = false){
        const self = this
        return new Promise((resolve, reject) => {
            const clientData = versionData.downloads.client
            const version = versionData.id
            const targetPath = path.join(self.commonPath, 'versions', version)
            const targetFile = version + '.jar'

            let client = new Asset(version + ' client', clientData.sha1, clientData.size, clientData.url, path.join(targetPath, targetFile))

            if(!AssetGuard._validateLocal(client.to, 'sha1', client.hash) || force){
                self.files.dlqueue.push(client)
                self.files.dlsize += client.size*1
                resolve()
            } else {
                resolve()
            }
        })
    }

    /**
     * Validate log config.
     *
     * @param {Object} versionData The version data for the assets.
     * @param {boolean} force Optional. If true, the asset index will be downloaded even if it exists locally. Defaults to false.
     * @returns {Promise.<void>} An empty promise to indicate the async processing has completed.
     */
    validateLogConfig(versionData){
        const self = this
        return new Promise((resolve, reject) => {
            const client = versionData.logging.client
            const file = client.file
            const targetPath = path.join(self.commonPath, 'assets', 'log_configs')

            let logConfig = new Asset(file.id, file.sha1, file.size, file.url, path.join(targetPath, file.id))

            if(!AssetGuard._validateLocal(logConfig.to, 'sha1', logConfig.hash)){
                self.files.dlqueue.push(logConfig)
                self.files.dlsize += logConfig.size*1
                resolve()
            } else {
                resolve()
            }
        })
    }

    // #endregion

    // Java (Category=''') Validation (download) Functions
    // #region

    _enqueueOpenJDK(dataDir){
        return new Promise((resolve, reject) => {
            JavaGuard._latestOpenJDK('8').then(verData => {
                if(verData != null){

                    dataDir = path.join(dataDir, 'runtime', 'x64')
                    const fDir = path.join(dataDir, verData.name)
                    const jre = new Asset(verData.name, null, verData.size, verData.uri, fDir)
                    this.java = new DLTracker([jre], jre.size, (a, self) => {
                        if(verData.name.endsWith('zip')){

                            const zip = new AdmZip(a.to)
                            const pos = path.join(dataDir, zip.getEntries()[0].entryName)
                            zip.extractAllToAsync(dataDir, true, (err) => {
                                if(err){
                                    console.log(err)
                                    self.emit('complete', 'java', JavaGuard.javaExecFromRoot(pos))
                                } else {
                                    fs.unlink(a.to, err => {
                                        if(err){
                                            console.log(err)
                                        }
                                        self.emit('complete', 'java', JavaGuard.javaExecFromRoot(pos))
                                    })
                                }
                            })

                        } else {
                            // Tar.gz
                            let h = null
                            fs.createReadStream(a.to)
                                .on('error', err => console.log(err))
                                .pipe(zlib.createGunzip())
                                .on('error', err => console.log(err))
                                .pipe(tar.extract(dataDir, {
                                    map: (header) => {
                                        if(h == null){
                                            h = header.name
                                        }
                                    }
                                }))
                                .on('error', err => console.log(err))
                                .on('finish', () => {
                                    fs.unlink(a.to, err => {
                                        if(err){
                                            console.log(err)
                                        }
                                        if(h.indexOf('/') > -1){
                                            h = h.substring(0, h.indexOf('/'))
                                        }
                                        const pos = path.join(dataDir, h)
                                        self.emit('complete', 'java', JavaGuard.javaExecFromRoot(pos))
                                    })
                                })
                        }
                    })
                    resolve(true)

                } else {
                    resolve(false)
                }
            })
        })

    }

    // Control Flow Functions
    // #region

    /**
     * Initiate an async download process for an AssetGuard DLTracker.
     *
     * @param {string} identifier The identifier of the AssetGuard DLTracker.
     * @param {number} limit Optional. The number of async processes to run in parallel.
     * @returns {boolean} True if the process began, otherwise false.
     */
    async startAsyncProcess(identifier, limit = 5) {

        const self = this
        const dlTracker = this[identifier]
        const dlQueue = dlTracker.dlqueue

        if(dlQueue.length > 0) {
            console.log('DLQueue', dlQueue)

            let err;

            for (const asset of dlQueue) {
                await new Promise(async (resolve, reject) => {
                    try {
                        fs.ensureDirSync(path.join(asset.to, '..'))

                        let req = await axios.get(asset.from, {
                            responseType: 'stream',
                            timeout: 15000
                        })
                            .catch(err => {
                                self.emit('error', 'download', err)
                            })

                        req.data.on('data', chunk => {
                            self.progress += chunk.length
                            self.emit('progress', 'download', self.progress, self.totaldlsize)
                        })

                        if (req.status === 200) {
                            let doHashCheck = false
                            const contentLength = parseInt(req.headers['content-length'])

                            if (contentLength !== asset.size) {
                                console.log(`WARN: Got ${contentLength} bytes for ${asset.id}: Expected ${asset.size}`)
                                doHashCheck = true

                                // Adjust download
                                this.totaldlsize -= asset.size
                                this.totaldlsize += contentLength
                            }

                            let writeStream = fs.createWriteStream(asset.to)
                            writeStream.on('close', () => {
                                if (dlTracker.callback != null) {
                                    dlTracker.callback.apply(dlTracker, [asset, self])
                                }

                                if (doHashCheck) {
                                    if (AssetGuard._validateLocal(asset.to, asset.type != null ? 'md5' : 'sha1', asset.hash)) {
                                        console.log(`Hashes match for ${asset.id}, byte mismatch is an issue in the distro index.`)
                                    } else {
                                        console.error(`Hashes do not match, ${asset.id} may be corrupted.`)
                                    }
                                }

                                resolve();
                            })

                            req.data.pipe(writeStream)
                        }
                        else {
                            console.log(`Failed to download ${asset.id}(${typeof asset.from === 'object' ? asset.from.url : asset.from}). Response code ${resp.statusCode}`)
                            self.progress += asset.size
                            self.emit('progress', 'download', self.progress, self.totaldlsize)
                            reject()
                        }
                    }
                    catch (ex) {
                        err = ex
                        reject()
                    }
                })
            }

            if (err) {
                console.log('An item in ' + identifier + ' failed to process')
            } else {
                console.log('All ' + identifier + ' have been processed successfully')
            }

            self[identifier] = new DLTracker([], 0)

            if (self.progress >= self.totaldlsize) {
                if (self.extractQueue.length > 0) {
                    self.emit('progress', 'extract', 1, 1)
                    AssetGuard._extractPackXZ(self.extractQueue, self.javaexec).then(() => {
                        self.extractQueue = []
                        self.emit('complete', 'download')
                    })
                } else {
                    self.emit('complete', 'download')
                }
            }

            return true
        } else {
            return false
        }
    }

    /**
     * This function will initiate the download processed for the specified identifiers. If no argument is
     * given, all identifiers will be initiated. Note that in order for files to be processed you need to run
     * the processing function corresponding to that identifier. If you run this function without processing
     * the files, it is likely nothing will be enqueued in the object and processing will complete
     * immediately. Once all downloads are complete, this function will fire the 'complete' event on the
     * global object instance.
     *
     * @param {Array.<{id: string, limit: number}>} identifiers Optional. The identifiers to process and corresponding parallel async task limit.
     */
    async processDlQueues(identifiers = [{id:'assets', limit:10}, {id:'libraries', limit:10}, {id:'files', limit:10}, {id:'forge', limit:5}]){
        return new Promise(async (resolve, reject) => {
            let shouldFire = true

            // Assign dltracking variables.
            this.totaldlsize = 0
            this.progress = 0

            for(let iden of identifiers){
                this.totaldlsize += this[iden.id].dlsize
            }

            this.once('complete', (data) => {
                resolve()
            })

            for (let iden of identifiers){
                let r = await this.startAsyncProcess(iden.id)
                if(r) shouldFire = false
            }

            if(shouldFire){
                this.emit('complete', 'download')
            }
        })
    }

    async validateEverything(){

        try {
            if (!ConfigManager.isLoaded())
                ConfigManager.load()

            // Validate Everything

            const versionData = await this.loadVersionData('1.8.9', true)
            this.emit('validate', 'version')
            await this.validateAssets(versionData)
            this.emit('validate', 'assets')
            await this.validateLibraries(versionData)
            this.emit('validate', 'libraries')
            await this.validateMiscellaneous(versionData)
            this.emit('validate', 'files')
            await this.processDlQueues()
            this.emit('complete', 'download')

            return {
                versionData
            }
        }
        catch (err){
            return {
                versionData: null,
                error: err
            }
        }


    }

    // #endregion

}

module.exports = {
    Util,
    AssetGuard,
    JavaGuard,
    Asset,
    Library
}