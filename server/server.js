const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());

// 静态文件托管（前端打包产物）
app.use(express.static(path.join(__dirname, "../client/build")));
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../client/build", "index.html"));
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function assignRoles(playerCount) {
    const roles = Array(playerCount).fill("villager");
    roles[0] = "预言家";
    roles[1] = "狼人";
    roles[2] = "平民";
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
}

const wordBank = ["苹果", "香蕉", "西瓜", "桌子", "椅子", "电脑", "手机", "飞机", "汽车", "猫", "狗", "老虎", "狮子", "长颈鹿", "河马"];
function getRandomWords(n) {
    const shuffled = [...wordBank].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
}

io.on("connection", socket => {
    console.log(`连接: ${socket.id}`);

    // 创建房间（房主和第一位玩家）
    socket.on("createRoom", ({ name, maxPlayers, duration }, callback) => {
        const roomId = Math.random().toString(36).substring(2, 8);

        const newRoom = {
            creatorId: socket.id, // 固定房主
            hostId: null,         // 每局主持人（开始游戏时决定）
            players: [{ id: socket.id, name, role: null }],
            maxPlayers,
            duration
        };

        rooms.set(roomId, newRoom);
        socket.join(roomId);

        io.to(roomId).emit("playerList", newRoom.players);

        // 把房主ID返回给创建者
        callback({ roomId, creatorId: newRoom.creatorId });
    });

    // 加入房间
    socket.on("joinRoom", ({ roomId, name }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback({ error: "房间不存在" });
        if (room.players.length >= room.maxPlayers) return callback({ error: "房间已满" });
        room.players.push({ id: socket.id, name, role: null });
        socket.join(roomId);
        io.to(roomId).emit("playerList", room.players);
        callback({ success: true, roomId, creatorId: room.creatorId });
    });

    // 开始游戏（只能房主点）
    socket.on("startGame", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        // 随机选主持人
        const randomCaptain = room.players[Math.floor(Math.random() * room.players.length)];
        room.hostId = randomCaptain.id;

        // 分配身份
        const roles = assignRoles(room.players.length);
        room.players.forEach((p, i) => (p.role = roles[i]));

        // 通知每个玩家身份
        room.players.forEach(p => io.to(p.id).emit("yourRole", p.role));

        // 广播主持人
        io.to(roomId).emit("newHost", { id: room.hostId, name: randomCaptain.name });

        io.to(roomId).emit("gameStarted");
    });

    // 只有主持人能获取词列表
    socket.on("getWordList", ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        if (socket.id !== room.hostId) return;

        const words = getRandomWords(5);
        io.to(room.hostId).emit("wordList", words);
    });

    // 只有主持人能选词
    socket.on("selectWord", ({ roomId, selected }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (socket.id !== room.hostId) return;

        room.players.forEach(p => {
            if (p.role === "预言家" || p.role === "狼人") {
                io.to(p.id).emit("yourWord", selected);
            }
        });

        io.to(roomId).emit("discussionStart", { duration: room.duration });
        let remaining = room.duration;
        const timer = setInterval(() => {
            remaining--;
            io.to(roomId).emit("timerUpdate", remaining);
            if (remaining <= 0) {
                clearInterval(timer);
                io.to(roomId).emit("discussionEnd");
            }
        }, 1000);
    });

    socket.on("selectWinner", ({ roomId, winner }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (winner === "good") {
            const wolves = room.players.filter(p => p.role === "wolf");
            wolves.forEach(w => io.to(w.id).emit("chooseKill", room.players));
        } else {
            io.to(roomId).emit("startVote", room.players);
        }
    });

    socket.on("wolfKill", ({ roomId, targetId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.players.find(p => p.id === targetId);
        const wolfScore = target && target.role === "seer" ? 1 : 0;
        io.to(roomId).emit("roundResult", { winner: "good", wolfScore, goodScore: 0 });
    });

    socket.on("voteWolves", ({ roomId, votes }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const wolves = room.players.filter(p => p.role === "wolf").map(p => p.id);
        const allCorrect = votes.length === wolves.length && votes.every(v => wolves.includes(v));
        if (allCorrect) {
            io.to(roomId).emit("roundResult", { winner: "good", wolfScore: 0, goodScore: 1 });
        } else {
            io.to(roomId).emit("roundResult", { winner: "wolf", wolfScore: 0, goodScore: 0 });
        }
    });

    socket.on("disconnect", () => {
        for (const [roomId, room] of rooms) {
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(roomId).emit("playerList", room.players);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));