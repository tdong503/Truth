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

// 分配身份（动态分配）
function assignRoles(playerCount) {
    if (playerCount < 4) {
        throw new Error("至少需要 4 名玩家才能开始游戏");
    }

    let roles = [];

    // 固定 1 预言家
    roles.push("seer");

    if (playerCount <= 8) {
        // 4~8 人：1 狼人
        roles.push("wolf");
    } else {
        // 9 人及以上：2 狼人
        roles.push("wolf", "wolf");
    }

    // 剩余填充为村民
    while (roles.length < playerCount) {
        roles.push("villager");
    }

    // 洗牌
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

function pickHostWeighted(players) {
    // 计算总权重
    const totalWeight = players.reduce((sum, p) => sum + (p.hostWeight ?? 1), 0);
    let rand = Math.random() * totalWeight;

    for (const p of players) {
        rand -= (p.hostWeight ?? 1);
        if (rand <= 0) {
            return p;
        }
    }
    return players[0]; // 兜底
}

io.on("connection", (socket) => {
    console.log(`连接: ${socket.id}`);

    // 创建房间
    socket.on("createRoom", ({ name, maxPlayers, duration }, callback) => {
        // 安全限制：最小 4 人，最大 12 人
        if (typeof maxPlayers !== "number" || maxPlayers < 4) {
            maxPlayers = 4;
        } else if (maxPlayers > 12) {
            maxPlayers = 12;
        }

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

        // 阶段检查：只有 waiting 才能加入
        if (room.phase !== "waiting") {
            return callback({ error: "游戏已开始，无法加入" });
        }

        // 检查人数上限
        if (room.players.length >= room.maxPlayers) {
            return callback({ error: "房间已满" });
        }

        const playerId = uuidv4();
        room.players.push({ id: playerId, socketId: socket.id, name, role: null, myWord: null });
        socket.join(roomId);

        io.to(roomId).emit("playerList", room.players);
        callback({ success: true, roomId, creatorId: room.creatorId, playerId });
    });

    // 主动退出
    socket.on("leaveRoom", ({ roomId, playerId }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        // 从房间移除玩家
        room.players = room.players.filter(p => p.id !== playerId);
        socket.leave(roomId);

        // 如果房间没人了，删除房间
        if (room.players.length === 0) {
            rooms.delete(roomId);
        } else {
            // 如果原房主退出，移交给第一个玩家
            const wasCreator = playerId === room.creatorId;
            if (wasCreator) {
                room.creatorId = room.players[0].id;
            }

            io.to(roomId).emit("playerList", room.players);
        }
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
            wordOptions: (player.id === room.hostId ? room.wordOptions : []),
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

        // 人数检查
        // if (room.players.length < 4) {
        //     io.to(roomId).emit("errorMessage", "人数不足，至少需要 4 名玩家才能开始游戏");
        //     return;
        // }

        // 重置房间状态
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

        // 重置玩家状态
        room.players.forEach(p => {
            p.myWord = null;
            p.role = null;
            io.to(p.socketId).emit("killTargetList", []);
        });

        // 初始化 hostWeight，第一次进游戏全部为 1
        room.players.forEach(p => {
            if (p.hostWeight === undefined) p.hostWeight = 1;
        });

        // 随机主持人
        const randomCaptain = pickHostWeighted(room.players);
        room.hostId = randomCaptain.id;

        // 更新权重
        room.players.forEach(p => {
            if (p.id === room.hostId) {
                p.hostWeight = 1; // 重置
            } else {
                p.hostWeight += 0.3; // 每局没当 +1
            }
        });

        try {
            // 分配身份
            const roles = assignRoles(room.players.length);
            room.players.forEach((p, i) => (p.role = roles[i]));
        } catch (err) {
            io.to(roomId).emit("errorMessage", err.message);
            return;
        }

        // 进入角色阶段
        room.phase = "role";
        io.to(roomId).emit("newHost", { id: room.hostId, name: randomCaptain.name });

        // 单独发送身份给每个玩家
        room.players.forEach((p) => {
            if (p.role === "wolf") {
                const wolfNames = room.players
                    .filter(pp => pp.role === "wolf" && pp.id !== p.id)
                    .map(pp => pp.name);
                io.to(p.socketId).emit("yourRole", { role: p.role, wolves: wolfNames });
            } else {
                io.to(p.socketId).emit("yourRole", { role: p.role });
            }
        });
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
            if (p.role === "seer" || p.role === "wolf" || p.id === room.hostId) {
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