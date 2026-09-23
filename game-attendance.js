// 参加予定の正本はschedule.games[].attendance。旧next-game形式は読み取り互換のみ。
function findAttendanceGame(games, current) {
  if (!current) return null;
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
  const matches = current.scheduleGameId
    ? games.filter(game => game.id === current.scheduleGameId)
    : games.filter(game => current.date && game.date === current.date && normalize(game.opponent) === normalize(current.opponent));
  return matches.length === 1 ? matches[0] : null;
}

function scheduleGameAttendance(game, games, current) {
  if (game.attendance && Array.isArray(game.attendance.members)) return game.attendance;
  return findAttendanceGame(games, current) === game && current.attendance && Array.isArray(current.attendance.members)
    ? current.attendance : null;
}

function nextGameAttendance(games, current) {
  const game = findAttendanceGame(games, current);
  if (game) return scheduleGameAttendance(game, games, current);
  // IDで紐付け済みの試合が削除された場合、別試合の情報を復活させない。
  return current && !current.scheduleGameId ? current.attendance : null;
}
