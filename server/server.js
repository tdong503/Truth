const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");
let uuidv4;
(async () => {
    const { v4 } = await import("uuid");
    uuidv4 = v4;
})();

const app = express();
app.use(cors());

app.use(express.static(path.join(__dirname, "../client/build")));
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../client/build", "index.html"));
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function assignRoles(playerCount) {
    const roles = Array(playerCount).fill("villager");
    roles[0] = "seer";
    roles[1] = "wolf";
    roles[2] = "villager";
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
}

const wordBank = [
    "苹果", "香蕉", "西瓜", "桌子", "椅子", "电脑", "手机", "飞机", "汽车",
    "猫", "狗", "老虎", "狮子", "长颈鹿", "河马"
];
function getRandomWords(n) {
    const shuffled = [...wordBank].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
}

io.on("connection", (socket) => {
    console.log(`连接: ${socket.id}`);

    // 创建房间
    socket.on("createRoom", ({ name, maxPlayers, duration }, callback) => {
        const playerId = uuidv4();
        const roomId = Math.random().toString(36).substring(2, 8);

        const newRoom = {
            creatorId: playerId,
            hostId: null,
            players: [{ id: playerId, socketId: socket.id, name, role: null, myWord: null }],
            maxPlayers,
            duration,
            timer: 0,
            phase: "waiting",
            wordOptions: [],
            selectedVotes: {}, // ✅ 初始化空对象
            result: null,
            votesRecord: {}, // 新增，保存投票人 → 被投对象
            killTarget: null // 新增，狼人击杀目标
        };

        rooms.set(roomId, newRoom);
        socket.join(roomId);

        io.to(roomId).emit("playerList", newRoom.players);
        callback({ roomId, creatorId: playerId, playerId });
    });

    // 加入房间
    socket.on("joinRoom", ({ roomId, name }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback({ error: "房间不存在" });
        if (room.players.length >= room.maxPlayers) return callback({ error: "房间已满" });

        const playerId = uuidv4();
        room.players.push({ id: playerId, socketId: socket.id, name, role: null, myWord: null });
        socket.join(roomId);

        io.to(roomId).emit("playerList", room.players);
        callback({ success: true, roomId, creatorId: room.creatorId, playerId });
    });

    // 重连
    socket.on("reconnectPlayer", ({ roomId, playerId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback({ error: "房间不存在" });

        const player = room.players.find((p) => p.id === playerId);
        if (!player) return callback({ error: "玩家不存在" });

        player.socketId = socket.id;
        socket.join(roomId);

        callback({
            success: true,
            roomId,
            creatorId: room.creatorId,
            currentHostId: room.hostId,
            players: room.players,
            phase: room.phase,
            timer: room.timer || 0,
            wordOptions: room.wordOptions || [],
            myRole: player.role || null,   // ✅ 恢复身份
            myWord: player.myWord || null, // ✅ 恢复词语
            selectedVotes: (room.selectedVotes && room.selectedVotes[player.id]) || [], // ✅ 兜底
            result: room.result || null
        });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        // 重置房间临时状态
        room.wordOptions = [];
        room.selectedVotes = {};
        room.votesRecord = {};
        room.killTarget = null;
        room.result = null;
        room.timer = 0;

        // 重置玩家状态
        room.players.forEach(p => {
            p.myWord = null;
            p.role = null;
        });

        // 分配主持人
        const randomCaptain = room.players[Math.floor(Math.random() * room.players.length)];
        room.hostId = randomCaptain.id;

        // 分配新角色
        const roles = assignRoles(room.players.length);
        room.players.forEach((p, i) => (p.role = roles[i]));

        room.phase = "role";

        // 发主持人信息
        io.to(roomId).emit("newHost", { id: room.hostId, name: randomCaptain.name });

        // 发每个人的身份
        room.players.forEach((p) => io.to(p.socketId).emit("yourRole", p.role));
    });

    socket.on("getWordList", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const host = room.players.find((p) => p.id === room.hostId);
        if (!host || socket.id !== host.socketId) return;

        const words = getRandomWords(5);
        room.wordOptions = words;
        io.to(socket.id).emit("wordList", words);
        room.phase = "wordSelect";
    });

    socket.on("selectWord", ({ roomId, selected }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const host = room.players.find((p) => p.id === room.hostId);
        if (!host || socket.id !== host.socketId) return;

        room.players.forEach((p) => {
            if (p.role === "seer" || p.role === "wolf") {
                p.myWord = selected; // ✅ 保存词语
                io.to(p.socketId).emit("yourWord", selected);
            }
        });

        room.phase = "discussion";
        room.timer = room.duration;
        io.to(roomId).emit("discussionStart", { duration: room.duration });

        let remaining = room.duration;
        const timer = setInterval(() => {
            remaining--;
            room.timer = remaining;
            io.to(roomId).emit("timerUpdate", remaining);
            if (remaining <= 0) {
                clearInterval(timer);
                room.phase = "endDiscussion";
                io.to(roomId).emit("discussionEnd");
            }
        }, 1000);
    });

    socket.on("selectWinner", ({ roomId, winner }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        if (winner === "good") {
            // 进入狼人击杀
            room.phase = "wolfKill";
            room.killTarget = null;
            const wolves = room.players.filter((p) => p.role === "wolf");

            // 给所有玩家发完整列表（保持 UI 正常）
            io.to(roomId).emit("playerList", room.players);

            // 单独给狼人发击杀目标
            wolves.forEach((w) => {
                const targetList = room.players.filter(p => p.role !== "wolf");
                io.to(w.socketId).emit("killTargetList", targetList);
            });

        } else {
            // 全民投票
            room.phase = "vote";
            room.selectedVotes = {};
            room.votesRecord = {};
            io.to(roomId).emit("startVote", room.players);
        }
    });

    socket.on("wolfKill", ({ roomId, targetId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        // 只记录一次击杀目标
        if (room.killTarget) return;
        room.killTarget = targetId;

        const target = room.players.find((p) => p.id === targetId);
        const seer = room.players.find((p) => p.role === "seer");
        const wolves = room.players.filter((p) => p.role === "wolf");

        const winner = target && target.role === "seer" ? "wolf" : "good";

        room.phase = "result";
        room.result = {
            winner,
            seerName: seer?.name || "未知",
            wolfNames: wolves.map(w => w.name),
            votesRecord: {} // 击杀没有投票
        };

        io.to(roomId).emit("roundResult", room.result);
    });

    socket.on("voteWolves", ({ roomId, votes }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.find((p) => p.socketId === socket.id);
        if (!player) return;

        const targetId = votes[0];
        room.selectedVotes[player.id] = targetId;
        room.votesRecord[player.name] = room.players.find(p => p.id === targetId)?.name || "无效票";

        if (Object.keys(room.selectedVotes).length === room.players.length) {
            // 统计票数
            const voteCounts = {};
            for (const pid of Object.values(room.selectedVotes)) {
                voteCounts[pid] = (voteCounts[pid] || 0) + 1;
            }

            // 生成排行
            const voteCountsSorted = Object.entries(voteCounts)
                .map(([pid, count]) => ({
                    name: room.players.find(p => p.id === pid)?.name || "未知",
                    count
                }))
                .sort((a, b) => b.count - a.count); // 从多到少

            const maxVotes = Math.max(...Object.values(voteCounts));
            const topVoted = Object.entries(voteCounts)
                .filter(([_, count]) => count === maxVotes)
                .map(([pid]) => pid);

            const wolves = room.players.filter(p => p.role === "wolf").map(p => p.id);

            let winner;
            if (topVoted.length === 1) {
                winner = wolves.includes(topVoted[0]) ? "good" : "wolf";
            } else {
                winner = topVoted.some(pid => wolves.includes(pid)) ? "good" : "wolf";
            }

            const seer = room.players.find((p) => p.role === "seer");
            room.phase = "result";
            room.result = {
                winner,
                seerName: seer?.name || "未知",
                wolfNames: room.players.filter(p => p.role === "wolf").map(w => w.name),
                votesRecord: room.votesRecord,
                voteCountsSorted // ✅ 新增票数排行
            };

            io.to(roomId).emit("roundResult", room.result);
        }
    });

    socket.on("disconnect", () => {
        for (const [roomId, room] of rooms) {
            const player = room.players.find((p) => p.socketId === socket.id);
            if (player) {
                player.socketId = null; // 保留玩家状态
            }
            io.to(roomId).emit("playerList", room.players);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));