/** 動画は写真と同じ一覧に `.mp4` のファイルとして入る。コドモンの写真は JPEG だけなので、拡張子で見分ける。 */
export const isVideo = (filename: string) => /\.mp4$/i.test(filename);
