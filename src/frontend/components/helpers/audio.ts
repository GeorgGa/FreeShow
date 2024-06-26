import { get } from "svelte/store"
import { uid } from "uid"
import { MAIN, OUTPUT } from "../../../types/Channels"
import { activePlaylist, audioChannels, audioPlaylists, gain, media, outLocked, playingAudio, playingVideos, special, volume } from "../../stores"
import { send } from "../../utils/request"
import { stopMetronome } from "../drawer/audio/metronome"
import { audioAnalyser } from "../output/audioAnalyser"
import { clone, shuffleArray } from "./array"
import { encodeFilePath } from "./media"
import { checkNextAfterMedia } from "./showActions"

export async function playAudio({ path, name = "", audio = null, stream = null }: any, pauseIfPlaying: boolean = true, startAt: number = 0, playMultiple: boolean = false, crossfade: number = 0) {
    let existing: any = get(playingAudio)[path]
    if (existing) {
        if (!pauseIfPlaying) {
            get(playingAudio)[path].audio.currentTime = 0
            return
        }

        playingAudio.update((a) => {
            let isPaused: boolean = a[path].paused
            a[path].paused = !isPaused
            if (isPaused) {
                a[path].audio.play()
                analyseAudio()
            } else a[path].audio.pause()
            return a
        })

        return
    }

    if (crossfade) crossfadeAudio(crossfade)
    else if (!playMultiple) clearAudio("", false)

    let encodedPath = encodeFilePath(path)
    audio = audio || new Audio(encodedPath)
    let analyser: any = await getAnalyser(audio, stream)

    playingAudio.update((a) => {
        if (!analyser) return a

        a[path] = {
            name: name.indexOf(".") > -1 ? name.slice(0, name.lastIndexOf(".")) : name,
            paused: false,
            mic: !!stream,
            analyser,
            audio,
        }

        return a
    })

    let localVolume: number = get(volume) * (get(media)[path]?.volume || 1)
    if (analyser.gainNode) analyser.gainNode.gain.value = localVolume * (get(gain) || 1)
    else audio.volume = localVolume

    if (crossfade) {
        audio.volume = 0
        crossfadeAudio(crossfade, path)
    }

    if (startAt > 0) audio.currentTime = startAt
    audio.play()

    analyseAudio()
}

// if no "path" is provided it will fade out/clear all audio
async function crossfadeAudio(crossfade: number = 0, path: string = "") {
    // fade in
    if (path) {
        let playing = get(playingAudio)[path]?.audio
        if (!playing) return

        fadeAudio(playing, crossfade, true)
        return
    }

    // fade out
    Object.entries(get(playingAudio)).forEach(([path, { audio }]) => {
        fadeoutAudio(audio, path)
    })

    async function fadeoutAudio(audio, path) {
        let faded = await fadeAudio(audio, crossfade)
        if (faded) deleteAudio(path)
    }

    function deleteAudio(path) {
        playingAudio.update((a) => {
            a[path]?.audio?.pause()
            delete a[path]

            return a
        })
    }
}

let unmutedValue = 1
export function updateVolume(value: number | undefined | "local", changeGain: boolean = false) {
    if (value !== "local") {
        // api mute(unmute)
        if (value === undefined) {
            value = get(volume) ? 0 : unmutedValue
            if (!value) unmutedValue = get(volume)
        }

        if (changeGain) gain.set(Number(Number(value).toFixed(2)))
        else volume.set(Number(Number(value).toFixed(2)))
    }

    // update volume on playing audio
    playingAudio.update((a) => {
        Object.keys(a).forEach((id) => {
            let localVolume: number = get(volume) * (get(media)[id]?.volume || 1)

            if (a[id].analyser.gainNode) {
                let gainedValue = localVolume * (get(gain) || 1)
                a[id].analyser.gainNode.gain.value = gainedValue
            } else a[id].audio.volume = localVolume
        })

        return a
    })

    if (get(volume)) analyseAudio()
}

// PLAYLIST

export function startPlaylist(id, specificSong: string = "") {
    if (!id) return

    activePlaylist.set({ id })
    playlistNext("", specificSong)
}

export function stopPlaylist() {
    let activeAudio = get(activePlaylist).active
    clearAudio(activeAudio)
}

export function updatePlaylist(id: string, key: string, value: any) {
    if (!get(audioPlaylists)[id]) return

    audioPlaylists.update((a) => {
        a[id][key] = value
        return a
    })
}

export function audioPlaylistNext() {
    if (get(outLocked) || !get(activePlaylist)?.id) return

    let playlistId = get(activePlaylist).id || ""
    let playlist = get(audioPlaylists)[playlistId] || {}
    let crossfade = Number(playlist.crossfade) || 0

    let activePath = get(activePlaylist).active
    playlistNext(activePath, "", crossfade)
}

export function playlistNext(previous: string = "", specificSong: string = "", crossfade: number = 0) {
    let id = get(activePlaylist)?.id
    if (!id) return

    let songs = getSongs()
    if (!songs.length) return

    let currentSongIndex = songs.findIndex((a) => a === (specificSong || previous))
    let nextSong = songs[currentSongIndex + (specificSong ? 0 : 1)]

    if (!nextSong) nextSong = songs[0]
    if (!nextSong) return

    activePlaylist.update((a) => {
        a.active = nextSong
        return a
    })

    if (crossfade) isCrossfading = true
    playAudio({ path: nextSong }, false, 0, false, crossfade)

    function getSongs(): string[] {
        if (previous && get(activePlaylist)?.songs) return get(activePlaylist).songs

        // generate list
        let playlist = clone(get(audioPlaylists)[id])
        if (!playlist) return []
        let songs = playlist.songs

        let mode = playlist.mode
        if (mode === "shuffle") songs = shuffleArray(songs)

        activePlaylist.update((a) => {
            a.songs = songs
            return a
        })

        return songs
    }
}

let audioStreams: any = {}
export function startMicrophone(mic) {
    navigator.mediaDevices
        .getUserMedia({
            audio: {
                deviceId: { exact: mic.id },
            },
        })
        .then((stream: any) => {
            audioStreams[mic.id] = stream

            let audio = new Audio()
            audio.srcObject = stream

            playAudio({ path: mic.id, name: mic.name, audio, stream }, false)
        })
        .catch((err) => {
            console.log(err)
            if (err.name === "NotReadableError") {
                window.api.send(MAIN, { channel: "ACCESS_MICROPHONE_PERMISSION" })
            }
        })
}

export function clearAudioStreams(id: string = "") {
    let ids = id ? [id] : Object.keys(audioStreams)

    ids.forEach((streamId) => {
        let stream = audioStreams[streamId]
        stream?.getAudioTracks().forEach((track: any) => track.stop())
    })
}

// const audioUpdateInterval: number = 100 // ms
const audioUpdateInterval: number = 50 // ms
let interval: any = null
let isCrossfading: boolean = false
export function analyseAudio() {
    if (interval) return

    let allAudio: any[] = []

    // let allAudio: any[] = Object.values(get(playingAudio)).filter((a) => a.paused === false && a.audio.volume)
    // if (get(volume) && get(playingVideos).length) get(playingVideos).map((a) => allAudio.push({ ...a }))

    let updateAudio: number = 10
    interval = setInterval(() => {
        // get new audio

        let playlistPath: string = get(activePlaylist)?.active || ""
        if (!isfading && playlistPath && !get(media)[playlistPath]?.loop) {
            if (isCrossfading) return

            let crossfadeDuration = checkCrossfade()
            if (crossfadeDuration) {
                isCrossfading = true
                setTimeout(() => (isCrossfading = false), crossfadeDuration)
                return
            }
        } else {
            isCrossfading = false
        }

        updateAudio++
        if (updateAudio >= 10) {
            updateAudio = 0
            allAudio = getPlayingAudio()
            allAudio.push(...getPlayingVideos()) // only used in output window I guess
        }

        allAudio = getPlayingOutputVideos(allAudio) // only used in main window

        if (!allAudio.length) {
            audioChannels.set({ left: 0, right: 0 })
            clearInterval(interval)
            interval = null

            send(OUTPUT, ["AUDIO_MAIN"], { channels: { left: 0, right: 0 } })
            return
        }

        mergeAudio(allAudio)
    }, audioUpdateInterval)
}

function mergeAudio(allAudio) {
    let allLefts: number[] = []
    let allRights: number[] = []

    allAudio.forEach((a: any) => {
        let channels: any
        if (a.channels !== undefined) channels = a.channels
        else channels = { left: audioAnalyser(a.analyser.left), right: audioAnalyser(a.analyser.right) }

        if (channels.left > 0 || channels.right > 0) {
            allLefts.push(channels.left)
            allRights.push(channels.right)
        }
    })

    let merged = { left: 0, right: 0 }
    if (allLefts.length || allRights.length) merged = { left: getHighestNumber(allLefts), right: getHighestNumber(allRights) }

    audioChannels.set(merged)
}

const extraMargin = 0.1 // s
function checkCrossfade(): number {
    let playlistId = get(activePlaylist)?.id || ""
    let playlist = get(audioPlaylists)[playlistId] || {}
    let crossfade = Number(playlist.crossfade) || 0
    let activePath = get(activePlaylist)?.active || ""
    if (!crossfade || !activePath) return 0

    let playing = get(playingAudio)[activePath]?.audio
    if (!playing) return 0

    let reachedEnding = playing.currentTime + crossfade + extraMargin >= playing.duration
    if (!reachedEnding) return 0

    playlistNext(activePath, "", crossfade)
    return crossfade
}

function getPlayingAudio() {
    return Object.entries(get(playingAudio))
        .map(([id, a]: any) => ({ id, ...a }))
        .filter((audio) => {
            let audioPath = audio.id
            if (!audio.audio) return false

            // check if finished
            if (!audio.paused && audio.audio.currentTime >= audio.audio.duration) {
                if (get(media)[audioPath]?.loop) {
                    get(playingAudio)[audioPath].audio.currentTime = 0
                    get(playingAudio)[audioPath].audio.play()
                } else if (get(activePlaylist)?.active === audioPath) {
                    playingAudio.update((a: any) => {
                        delete a[audioPath]
                        return a
                    })

                    playlistNext(audioPath)
                    return false
                } else {
                    playingAudio.update((a: any) => {
                        if (get(special).clearMediaOnFinish === false) {
                            // a[audioPath].audio?.pause()
                            a[audioPath].paused = true
                        } else {
                            delete a[audioPath]
                        }

                        return a
                    })

                    let stillPlaying = Object.values(get(playingAudio)).filter((a) => !a.audio?.paused)
                    if (!stillPlaying.length) checkNextAfterMedia(audioPath, "audio")
                    return false
                }
            }

            return audio.paused === false && audio.audio.volume
        })
}

function getPlayingVideos() {
    // remove cleared videos
    let videos: any[] = get(playingVideos).filter((a) => document.contains(a.video))
    if (!videos.length) return []

    let allAudio: any[] = []

    videos.map((a) => {
        // set volume (video in output window)
        let newVolume = get(volume)
        if (a.analyser.gainNode) {
            let gainedValue = newVolume * (get(gain) || 1)
            a.analyser.gainNode.gain.value = gainedValue
        } else a.video.volume = newVolume

        if (!a.paused) allAudio.push(a)
    })

    return allAudio
}

function getPlayingOutputVideos(allAudio) {
    let outputVideos: any[] = get(playingVideos).filter((a) => a.location === "output")
    if (!outputVideos.length) return allAudio

    outputVideos.map((v) => {
        let existing = allAudio.findIndex((a) => a.id === v.id && a.location === "output")
        if (existing > -1) {
            if (v.paused) {
                allAudio.splice(existing, 1)
                return
            }

            allAudio[existing].channels = v.channels
            return
        }

        if (v.paused) return
        allAudio.push(v)
    })

    return allAudio
}

// function getAverageNumber(numbers: number[]): number {
//   let total: number = numbers.reduce((count: number, num: number): number => count + num)
//   return total / numbers.length
// }

function getHighestNumber(numbers: number[]): number {
    return Math.max(...numbers)
}

let clearing = false
export function clearAudio(path: string = "", clearPlaylist: boolean = true) {
    // turn off any playlist
    if (clearPlaylist && (!path || get(activePlaylist)?.active === path)) activePlaylist.set(null)

    // stop playing metronome
    if (clearPlaylist && !path) stopMetronome()

    // let clearTime = get(transitionData).audio.duration
    // TODO: starting audio before previous clear is finished will not start/clear audio
    const clearTime = get(special).audio_fade_duration ?? 1.5

    if (clearing) return // setTimeout(() => clearAudio(path), clearTime * 1000 + 200)
    if (!Object.keys(get(playingAudio)).length) return
    clearing = true

    let newPlaying: any = get(playingAudio)
    playingAudio.update((a) => {
        if (path) clearAudio(path)
        else Object.keys(get(playingAudio)).forEach(clearAudio)

        return a

        async function clearAudio(path) {
            if (!a[path].audio) return deleteAudio(path)

            let faded = await fadeAudio(a[path].audio, clearTime)
            if (faded) removeAudio(path)
        }

        function removeAudio(path) {
            if (!a[path]?.audio) return deleteAudio(path)

            a[path].audio.pause()
            deleteAudio(path)
        }

        function deleteAudio(path) {
            delete a[path]
            newPlaying = a

            startUpdate()
        }
    })

    let updating = false
    function startUpdate() {
        if (updating) return
        updating = true

        setTimeout(() => {
            playingAudio.set(newPlaying)
            clearAudioStreams()
            clearing = false
        }, 200)
    }
}

// fade out/in when video starts playing
let isfading = false
export function fadeoutAllPlayingAudio() {
    stopFading()
    isfading = true

    Object.values(get(playingAudio)).forEach(({ audio }) => {
        fadeoutAudio(audio)
    })

    async function fadeoutAudio(audio) {
        let faded = await fadeAudio(audio, get(special).audio_fade_duration ?? 1.5)
        if (faded) {
            audio.pause()
            // analyseAudio()
        }
    }
}
export function fadeinAllPlayingAudio() {
    if (!isfading) return
    stopFading()

    Object.values(get(playingAudio)).forEach(({ audio }) => {
        fadeinAudio(audio)
    })

    isfading = false

    async function fadeinAudio(audio) {
        audio.play()
        await fadeAudio(audio, get(special).audio_fade_duration ?? 1.5, true)
        // if (faded) analyseAudio()
    }
}

function stopFading() {
    Object.values(currentlyFading).forEach((fadeInterval: any) => {
        clearInterval(fadeInterval)
    })
}

const speed = 0.01
let currentlyFading: any = {}
async function fadeAudio(audio, duration = 1, increment: boolean = false): Promise<boolean> {
    if (!audio || !duration) return true

    let time = duration * 1000 * speed

    // WIP non linear easing

    let fadeId = uid()
    return new Promise((resolve) => {
        currentlyFading[fadeId] = setInterval(() => {
            if (increment) {
                audio.volume = Math.min(1, Number((audio.volume + speed).toFixed(3)))
                if (audio.volume === 1) finished()
            } else {
                audio.volume = Math.max(0, Number((audio.volume - speed).toFixed(3)))
                if (audio.volume === 0) finished()
            }
        }, time)

        let timedout = setTimeout(() => {
            clearInterval(currentlyFading[fadeId])
            resolve(false)
        }, duration * 1200)

        function finished() {
            clearInterval(currentlyFading[fadeId])
            clearTimeout(timedout)
            setTimeout(() => resolve(true), 50)
        }
    })
}

// https://stackoverflow.com/questions/20769261/how-to-get-video-elements-current-level-of-loudness
export async function getAnalyser(elem: any, stream: any = null) {
    let ac = new AudioContext()
    let source

    try {
        if (stream) source = ac.createMediaStreamSource(stream)
        else source = ac.createMediaElementSource(elem)
    } catch (err) {
        console.error(err)

        return
    }

    // if (stream) {
    //     let audioDestination = ac.createMediaStreamDestination()

    //     let analyser = ac.createAnalyser()
    //     analyser.smoothingTimeConstant = 0.9
    //     analyser.fftSize = 256

    //     let gainNode = ac.createGain()
    //     source.connect(gainNode)

    //     gainNode.connect(analyser)
    //     gainNode.connect(audioDestination)

    //     return { left: analyser, right: analyser, gainNode }
    // }

    // let analyser = ac.createAnalyser()
    // analyser.smoothingTimeConstant = 0.9
    // // analyser.fftSize = 512 // the total samples are half the fft size
    // analyser.fftSize = 256 // the total samples are half the fft size

    // source.connect(analyser)
    // analyser.connect(ac.destination)

    // split channels
    // https://stackoverflow.com/questions/48930799/connecting-nodes-with-each-other-with-the-web-audio-api
    let splitter = ac.createChannelSplitter(2)
    let merger = ac.createChannelMerger(2)
    source.connect(splitter)

    let leftAnalyser = ac.createAnalyser()
    let rightAnalyser = ac.createAnalyser()
    leftAnalyser.smoothingTimeConstant = 0.9
    rightAnalyser.smoothingTimeConstant = 0.9
    leftAnalyser.fftSize = 256
    rightAnalyser.fftSize = 256
    splitter.connect(leftAnalyser, 0) // left analyzer
    splitter.connect(rightAnalyser, 1) // right analyzer

    splitter.connect(merger, 0, 0) // left audio
    splitter.connect(merger, 1, 1) // right audio

    // gain (volume)
    // https://stackoverflow.com/questions/43698961/how-to-set-volumes-in-webrtc
    let gainNode = ac.createGain()
    source.connect(gainNode)
    gainNode.connect(ac.destination)

    console.log("ANALYZING AUDIO", elem)

    // custom audio output
    // let audioDest = ac.createMediaStreamDestination()
    // source.connect(audioDest)
    // let newAudio: any = new Audio()
    // newAudio.srcObject = audioDest.stream
    // WIP this works in Chrome 110: (Electron needs to be updated!)
    // https://developer.chrome.com/blog/audiocontext-setsinkid/
    // if (get(special).audioOutput) {
    //     try {
    //         await (ac as any).setSinkId(get(special).audioOutput)
    //     } catch (err) {
    //         console.error(err)
    //     }
    // }

    return { left: leftAnalyser, right: rightAnalyser, gainNode }
}

export async function getAudioDuration(path: string): Promise<number> {
    return new Promise((resolve) => {
        let audio: any = new Audio(path)
        audio.addEventListener("canplaythrough", (_: any) => {
            resolve(audio.duration)
        })
    })
}
