export type SaveList = SaveListSettings | SaveListSyncedSettings | "themes" | "events" | "templates" | "driveKeys"

export type SaveListSyncedSettings = "categories" | "drawSettings" | "overlayCategories" | "templateCategories" | "timers" | "scriptures" | "scriptureSettings" | "groups" | "midiIn"

export type SaveListSettings =
    | "initialized"
    | "activeProject"
    | "alertUpdates"
    | "audioFolders"
    | "autoOutput"
    | "timeFormat"
    | "defaultProjectName"
    | "showsPath"
    | "exportPath"
    | "scripturePath"
    | "drawer"
    | "drawerTabsData"
    | "groupNumbers"
    | "fullColors"
    | "formatNewShow"
    | "imageExtensions"
    | "labelsDisabled"
    | "language"
    | "maxConnections"
    | "mediaFolders"
    | "mediaOptions"
    | "openedFolders"
    | "os"
    | "outputs"
    | "styles"
    | "outLocked"
    | "presenterControllerKeys"
    | "playerVideos"
    | "ports"
    | "remotePassword"
    | "resized"
    | "slidesOptions"
    | "splitLines"
    | "theme"
    | "transitionData"
    | "videoExtensions"
    | "webFavorites"
    | "volume"
    | "driveData"
    | "calendarAddShow"
