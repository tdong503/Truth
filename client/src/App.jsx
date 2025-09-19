import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";
import HiddenCard from "./HiddenCard";
import "./App.css";

const socket = io();

function PlayerList({ players, currentHostId, creatorId }) {
    return (
        <ul className="player-list">
            {players.map((p) => (
                <li key={p.id}>
                    {p.name}
                    {p.id === creatorId && "(房主 👑)"}
                    {p.id === currentHostId && "(主持人 🏅)"}
                </li>
            ))}
        </ul>
    );
}

export default function App() {
    const [phase, setPhase] = useState("lobby");
    const [roomId, setRoomId] = useState("");
    const [name, setName] = useState("");
    const [players, setPlayers] = useState([]);
    const [role, setRole] = useState(null);
    const [wordOptions, setWordOptions] = useState([]);
    const [myWord, setMyWord] = useState(null);
    const [timer, setTimer] = useState(0);
    const [selectedVotes, setSelectedVotes] = useState([]);
    const [result, setResult] = useState(null);

    const [creatorId, setCreatorId] = useState(null);
    const [currentHostId, setCurrentHostId] = useState(null);
    const [playerId, setPlayerId] = useState(null);

    const [killTargets, setKillTargets] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [customWord, setCustomWord] = useState("");

    useEffect(() => {
        socket.on("playerList", (list) => setPlayers(list));
        socket.on("yourRole", ({ role, wolves }) => {
            setRole(role);
            setMyWord(null);
            if (role === "wolf" && wolves && wolves.length > 0) {
                setRole(`${role}（同伴: ${wolves.join(", ")})`);
            }
            setPhase("role");
        });
        socket.on("wordList", (ws) => {
            setWordOptions(ws);
            setPhase("wordSelect");
        });
        socket.on("yourWord", (w) => setMyWord(w));
        socket.on("discussionStart", ({ duration }) => {
            setPhase("discussion");
            setTimer(duration);
        });
        socket.on("timerUpdate", (t) => setTimer(t));
        socket.on("discussionEnd", () => setPhase("endDiscussion"));
        socket.on("chooseKill", (list) => {
            setPlayers(list);
            setPhase("wolfKill");
        });
        socket.on("startVote", (list) => {
            setPlayers(list);
            setSelectedVotes([]);
            setPhase("vote");
        });
        socket.on("roundResult", (res) => {
            setResult(res);
            setPhase("result");
        });
        socket.on("newHost", ({ id }) => setCurrentHostId(id));
        socket.on("killTargetList", (list) => {
            setKillTargets(list);
            setPhase("wolfKill");
        });
        socket.on("errorMessage", (msg) => alert(msg));
    }, []);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const rid = params.get("roomId");
        if (rid && !roomId) {
            setRoomId(rid);
        }

        const savedRoomId = localStorage.getItem("roomId");
        const savedPlayerId = localStorage.getItem("playerId");

        if (savedRoomId && savedPlayerId) {
            socket.emit(
                "reconnectPlayer",
                { roomId: savedRoomId, playerId: savedPlayerId },
                (res) => {
                    if (res.success) {
                        setRoomId(res.roomId);
                        setCreatorId(res.creatorId);
                        setCurrentHostId(res.currentHostId);
                        setPlayers(res.players);
                        setPhase(res.phase || "waiting");
                        setTimer(res.timer || 0);
                        setPlayerId(savedPlayerId);
                        setRole(res.myRole || null);
                        setMyWord(res.myWord || null);
                        setWordOptions(res.wordOptions || []);
                        setSelectedVotes(res.selectedVotes || []);
                        if (res.phase === "result" && res.result) setResult(res.result);
                    } else {
                        localStorage.removeItem("roomId");
                        localStorage.removeItem("playerId");
                    }
                }
            );
        }
    }, []);

    const createRoom = () => {
        if (!name) return alert("请输入昵称");
        socket.emit("createRoom", { name, maxPlayers: 12, duration: 240 }, (res) => {
            setRoomId(res.roomId);
            setCreatorId(res.creatorId);
            setPlayerId(res.playerId);
            localStorage.setItem("roomId", res.roomId);
            localStorage.setItem("playerId", res.playerId);
        });
        setPhase("waiting");
    };

    const joinRoom = () => {
        if (!name) {
            alert("请输入昵称");
            return;
        }
        if (!roomId) {
            alert("请输入房间ID");
            return;
        }
        socket.emit("joinRoom", {roomId, name}, (res) => {
            if (!res.error) {
                setCreatorId(res.creatorId);
                setPlayerId(res.playerId);
                localStorage.setItem("roomId", res.roomId);
                localStorage.setItem("playerId", res.playerId);
                setPhase("waiting");
            } else alert(res.error);
        });
    };

    const leaveRoom = () => {
        if (!roomId || !playerId) return;
        socket.emit("leaveRoom", { roomId, playerId });
        localStorage.removeItem("roomId");
        localStorage.removeItem("playerId");
        setRoomId("");
        setPlayers([]);
        setPhase("lobby");
    };

    const startGame = () => {
        if (players.length < 4) return alert("人数不足，至少需要 4 名玩家");
        setKillTargets(null); // 清除上一局的击杀目标
        socket.emit("startGame", { roomId });
    };

    return (
        <div className="app-container">
            {players.length > 0 && (
                <div className="room-info">
                    <h3>
                        房间 ID: {roomId}
                        {phase === "result" && result && (
                            <button className="danger" onClick={leaveRoom}>
                                退出房间
                            </button>
                        )}
                    </h3>
                    <PlayerList
                        players={players}
                        currentHostId={currentHostId}
                        creatorId={creatorId}
                    />
                </div>
            )}

            {phase === "lobby" && (
                <div className="panel">
                    <h1>狼人真言</h1>
                    <input placeholder="昵称" value={name} onChange={(e) => setName(e.target.value)} />
                    <input placeholder="房间ID（加入房间必填）" value={roomId} onChange={(e) => setRoomId(e.target.value)} />

                    <div className="button-group">
                        <button className={name && roomId ? "primary" : "secondary"} disabled={!name || !roomId} onClick={joinRoom}>加入房间</button>
                        <span className="or">或</span>
                        <button className={!roomId ? "primary" : "secondary"} disabled={!name} onClick={createRoom}>创建房间</button>
                    </div>
                </div>
            )}

            {phase === "waiting" && (
                <div className="panel">
                    {playerId === creatorId && (
                        <button className="primary" onClick={startGame}>
                            开始游戏
                        </button>
                    )}
                    {roomId && (
                        <button
                            className="secondary"
                            onClick={() => {
                                const link = `${window.location.origin}?roomId=${roomId}`;
                                navigator.clipboard
                                    .writeText(link)
                                    .then(() => alert("分享链接已复制！"))
                                    .catch(() => alert("复制失败"));
                            }}
                        >
                            分享房间链接
                        </button>
                    )}
                    <button className="danger" onClick={leaveRoom}>
                        退出房间
                    </button>
                </div>
            )}

            {phase !== "lobby" && phase !== "waiting" && (
                <div className="role-card">
                    <h2>身份</h2>
                    <HiddenCard
                        text={myWord ? `${role}，词语是：${myWord}` : role}
                        cover="鼠标放到上面查看身份"
                        width={600}
                        height={50}
                    />
                    {playerId === currentHostId && (
                        <div className="tips">
                            <p>疑问句：是 / 不是 / 不知道</p>
                            <p>猜答案：接近了 / 差很多 / 正确</p>
                        </div>
                    )}
                </div>
            )}

            {phase === "role" && (
                <div className="panel">
                    {playerId === currentHostId && (
                        <button onClick={() => socket.emit("getWordList", {roomId})}>
                            获取词列表（主持人专属）
                        </button>
                    )}
                    {playerId !== currentHostId && <p>等待主持人获取词列表...</p>}
                </div>
            )}

            {phase === "wordSelect" && playerId === currentHostId && (
                <div className="panel">
                    <h2>选择词</h2>
                    <div className="button-grid">
                        {wordOptions.map((w, idx) => (
                            <button
                                key={idx}
                                className="primary"
                                onClick={() => socket.emit("selectWord", { roomId, selected: w })}
                            >
                                {w}
                            </button>
                        ))}
                    </div>
                    <input
                        placeholder="自定义词语"
                        value={customWord}
                        onChange={(e) => setCustomWord(e.target.value)}
                    />
                    <button
                        className="secondary"
                        onClick={() => {
                            if (customWord.trim()) {
                                socket.emit("selectWord", {
                                    roomId,
                                    selected: customWord.trim(),
                                });
                                setCustomWord("");
                            }
                        }}
                    >
                        提交自定义词
                    </button>
                </div>
            )}

            {phase === "discussion" && (
                <div className="panel">
                    <h2>讨论中...</h2>
                    <p>剩余时间: {timer}</p>
                    {playerId === currentHostId && (
                        <div className="button-grid">
                            <button
                                onClick={() => {
                                    if (window.confirm("确定要提前结束并进入狼人击杀阶段吗？")) {
                                        socket.emit("forceEndDiscussion", {roomId});
                                    }
                                }}
                            >
                                提前结束讨论
                            </button>
                        </div>
                    )}
                </div>
            )}

            {phase === "wolfKill" && (
                <div className="panel">
                    <h2>狼人击杀</h2>
                    <div className="button-grid">
                        {(killTargets || []).map((p) => (
                            <button
                                key={p.id}
                                className="danger"
                                onClick={() =>
                                    socket.emit("wolfKill", { roomId, targetId: p.id })
                                }
                            >
                                {p.name}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {phase === "vote" && (
                <div className="panel">
                    <h2>全民投票（每人选1个玩家）</h2>
                    <div className="button-grid">
                        {players.map((p) => (
                            <button
                                key={p.id}
                                className={selectedVotes.includes(p.id) ? "primary" : "secondary"}
                                onClick={() => setSelectedVotes([p.id])}
                            >
                                {p.name}
                            </button>
                        ))}
                    </div>
                    {selectedVotes.length === 1 && (
                        <button
                            className="primary"
                            disabled={isSubmitting}
                            onClick={() => {
                                setIsSubmitting(true);
                                socket.emit("voteWolves", { roomId, votes: selectedVotes });
                            }}
                        >
                            提交
                        </button>
                    )}
                </div>
            )}

            {phase === "result" && result && (
                <div className="panel">
                    <h2>结果</h2>
                    <p>胜方: {result.winner === "good" ? "好人" : "狼人"}</p>
                    <p>预言家: {result.seerName}</p>
                    <p>狼人: {result.wolfNames?.join(", ")}</p>
                    {result.votesRecord && Object.keys(result.votesRecord).length > 0 && (
                        <div>
                            <h3>投票结果:</h3>
                            <ul>
                                {Object.entries(result.votesRecord).map(([voter, target]) => (
                                    <li key={voter}>{voter} → {target}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {result.voteCountsSorted && result.voteCountsSorted.length > 0 && (
                        <div>
                            <h3>票数排行:</h3>
                            <ul>
                                {result.voteCountsSorted.map((p, idx) => (
                                    <li key={idx}>
                                        {p.name} — {p.count} 票
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {playerId === currentHostId && (
                        <button className="primary" onClick={startGame}>
                            重新开局
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}