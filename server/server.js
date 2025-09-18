const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

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

// 读取本地词库
function loadWordBank() {
    const filePath = path.join(__dirname, "wordbank.txt");
    if (!fs.existsSync(filePath)) {
        console.warn("⚠️ 找不到 wordbank.txt，将使用默认词库");
        return [
            "苹果", "香蕉", "西瓜", "桌子", "椅子", "电脑", "手机", "飞机", "汽车",
            "猫", "狗", "老虎", "狮子", "长颈鹿", "河马"
        ];
    }
    return fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map(w => w.trim())
        .filter(Boolean);
}
let wordBank = loadWordBank();

// 随机取词
function getRandomWords(n) {
    if (wordBank.length <= n) return [...wordBank];
    const shuffled = [...wordBank];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, n);
}

// 分配身份
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

// 公共方法：进入狼人击杀
function enterWolfKill(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.phase = "wolfKill";
    room.killTarget = null;

    const wolves = room.players.filter((p) => p.role === "wolf");
    const nonWolves = room.players.filter((p) => p.role !== "wolf");

    io.to(roomId).emit("playerList", room.players);

    wolves.forEach((w) => {
        io.to(w.socketId).emit("killTargetList", nonWolves);
    });

    nonWolves.forEach((p) => {
        io.to(p.socketId).emit("killTargetList", []);
    });
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
            selectedVotes: {},
            votesRecord: {},
            killTarget: null,
            result: null,
            discussionTimerId: null
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
            myRole: player.role || null,
            myWord: player.myWord || null,
            selectedVotes: (room.selectedVotes && room.selectedVotes[player.id]) || [],
            result: room.result || null
        });
    });

    // 开新局
    socket.on("startGame", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        room.wordOptions = [];
        room.selectedVotes = {};
        room.votesRecord = {};
        room.killTarget = null;
        room.result = null;
        room.timer = 0;
        if (room.discussionTimerId) {
            clearInterval(room.discussionTimerId);
            room.discussionTimerId = null;
        }

        room.players.forEach(p => {
            p.myWord = null;
            p.role = null;
            io.to(p.socketId).emit("killTargetList", []);
        });

        const randomCaptain = room.players[Math.floor(Math.random() * room.players.length)];
        room.hostId = randomCaptain.id;

        const roles = assignRoles(room.players.length);
        room.players.forEach((p, i) => (p.role = roles[i]));

        room.phase = "role";
        io.to(roomId).emit("newHost", { id: room.hostId, name: randomCaptain.name });

        room.players.forEach((p) => io.to(p.socketId).emit("yourRole", p.role));
    });

    // 主持人获取词列表
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

    // 选择词（包括自定义）
    socket.on("selectWord", ({ roomId, selected }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const host = room.players.find((p) => p.id === room.hostId);
        if (!host || socket.id !== host.socketId) return;

        selected = (selected || "").trim();
        if (!selected) return; // 防止空字符串

        room.players.forEach((p) => {
            if (p.role === "seer" || p.role === "wolf") {
                p.myWord = selected;
                io.to(p.socketId).emit("yourWord", selected);
            }
        });

        room.phase = "discussion";
        room.timer = room.duration;
        io.to(roomId).emit("discussionStart", { duration: room.duration });

        let remaining = room.duration;
        room.discussionTimerId = setInterval(() => {
            remaining--;
            room.timer = remaining;
            io.to(roomId).emit("timerUpdate", remaining);
            if (remaining <= 0) {
                clearInterval(room.discussionTimerId);
                room.discussionTimerId = null;
                room.phase = "endDiscussion";
                io.to(roomId).emit("discussionEnd");
            }
        }, 1000);
    });

    // 提前结束讨论
    socket.on("forceEndDiscussion", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const host = room.players.find((p) => p.id === room.hostId);
        if (!host || socket.id !== host.socketId) return;

        if (room.discussionTimerId) {
            clearInterval(room.discussionTimerId);
            room.discussionTimerId = null;
        }
        enterWolfKill(roomId);
    });

    // 主持人选择胜方
    socket.on("selectWinner", ({ roomId, winner }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        if (winner === "good") {
            enterWolfKill(roomId);
        } else {
            room.phase = "vote";
            room.selectedVotes = {};
            room.votesRecord = {};
            io.to(roomId).emit("startVote", room.players);
        }
    });

    // 狼人击杀
    socket.on("wolfKill", ({ roomId, targetId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

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
            votesRecord: {}
        };

        io.to(roomId).emit("roundResult", room.result);
    });

    // 投票
    socket.on("voteWolves", ({ roomId, votes }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.find((p) => p.socketId === socket.id);
        if (!player) return;

        const targetId = votes[0];
        room.selectedVotes[player.id] = targetId;
        room.votesRecord[player.name] = room.players.find(p => p.id === targetId)?.name || "无效票";

        if (Object.keys(room.selectedVotes).length === room.players.length) {
            const voteCounts = {};
            for (const pid of Object.values(room.selectedVotes)) {
                voteCounts[pid] = (voteCounts[pid] || 0) + 1;
            }

            const voteCountsSorted = Object.entries(voteCounts)
                .map(([pid, count]) => ({
                    name: room.players.find(p => p.id === pid)?.name || "未知",
                    count
                }))
                .sort((a, b) => b.count - a.count);

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
                voteCountsSorted
            };

            io.to(roomId).emit("roundResult", room.result);
        }
    });

    socket.on("disconnect", () => {
        for (const [roomId, room] of rooms) {
            const player = room.players.find((p) => p.socketId === socket.id);
            if (player) {
                player.socketId = null;
            }
            io.to(roomId).emit("playerList", room.players);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));