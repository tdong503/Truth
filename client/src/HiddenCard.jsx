import React from "react";
import "./HiddenCard.css";

/**
 * @param {string} text     - 鼠标悬停时显示的内容
 * @param {string} cover    - 默认盖牌显示的内容（默认 "********"）
 * @param {number} width    - 卡片宽度（默认 150px）
 * @param {number} height   - 卡片高度（默认 50px）
 */
export default function HiddenCard({ text, cover = "********", width = 150, height = 50 }) {
    return (
        <div
            className="hidden-card"
            style={{ width: `${width}px`, height: `${height}px` }}
        >
            <span className="hidden-text">{text}</span>
            <span className="cover">{cover}</span>
        </div>
    );
}