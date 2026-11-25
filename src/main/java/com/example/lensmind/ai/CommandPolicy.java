package com.example.lensmind.ai;

import static com.example.lensmind.ai.AiContracts.*;
import java.util.regex.Pattern;

public final class CommandPolicy {
    private CommandPolicy() {}
    public static String text(String value, int max, String field) {
        if (value == null || value.isBlank() || value.length() > max) throw AiException.badInput(field + "不能为空，且不得超过 " + max + " 字符");
        return value.trim();
    }
    public static Command clarify(String message) { return new Command(Intent.CLARIFY, null, null, null, null, null, message); }
    public static Command simple(Intent type, String message) { return new Command(type, null, null, null, null, null, message); }
    private static boolean matches(String text, String regex) { return Pattern.compile(regex).matcher(text).find(); }
    /** Whisper 中文输出可能包含繁体；只归一化控制词，ASR 原始转写仍保留。 */
    public static String normalize(String text) {
        for (String[] pair : new String[][]{{"相機", "相机"}, {"鏡頭", "镜头"}, {"機位", "机位"},
                {"別動", "别动"}, {"別拍", "别拍"}, {"復位", "复位"}, {"縮小", "缩小"},
                {"動作", "动作"}, {"建議", "建议"}, {"一張", "一张"}, {"怎麼擺", "怎么摆"}}) {
            text = text.replace(pair[0], pair[1]);
        }
        return text;
    }
    public static Command guard(String text) {
        if (matches(text, "停止|停下|急停|别动")) return simple(Intent.STOP, "停止请求应立即直达 /api/device/stop，取消倒计时和待执行动作");
        if (matches(text, "不要|别拍|不拍|别移动|不移动")) return clarify("未执行动作。需要取消当前操作时请点击停止。");
        if (matches(text, "相机|镜头|机位") && matches(text, "靠近|远离|向前|向后|往前|往后")) return clarify("当前模拟接口未提供前后移动；可明确要求数字放大，或使用支持的上下左右微调。");
        return null;
    }
    public static Command mock(String text) {
        Command guarded = guard(text);
        if (guarded != null) return guarded;
        if (matches(text, "回初始|回原位|复位")) return simple(Intent.HOME, "请求回到初始位");
        if (matches(text, "指导|建议|姿势|怎么摆")) return simple(Intent.GUIDE, "请看向镜头，轻轻放松肩膀。（模拟预设指导）");
        if (matches(text, "放大|缩小|拉近|拉远") && !matches(text, "相机|镜头|机位")) return new Command(Intent.ZOOM, null, null, null, null, matches(text, "缩小|拉远") ? -.15 : .15, "仅调整数字裁剪");
        if (matches(text, "相机|镜头|机位")) {
            Direction direction = null;
            int count = 0;
            for (var entry : java.util.Map.of("左", Direction.LEFT, "右", Direction.RIGHT, "上", Direction.UP, "下", Direction.DOWN).entrySet()) {
                if (text.contains(entry.getKey())) { direction = entry.getValue(); count++; }
            }
            if (count == 1) return new Command(Intent.MOVE, direction, 1, null, null, null, "仅提出一步模拟微调，由控制端校验执行");
            return clarify("请明确一个机位方向，例如相机向左一点。");
        }
        if (matches(text, "居中|三分|靠左|靠右|半身|全身")) {
            if (text.contains("左") && text.contains("右")) return clarify("人物希望位于画面左侧还是右侧？");
            Composition composition = text.contains("左") ? Composition.left : text.contains("右") ? Composition.right : text.contains("居中") ? Composition.center : null;
            Framing framing = text.contains("全身") ? Framing.full : text.contains("半身") ? Framing.half : null;
            return new Command(Intent.COMPOSE, null, null, composition, framing, null, "更新构图目标，不自动移动机械臂");
        }
        if (matches(text, "拍照|重拍|拍一张|拍张|来一张")) return simple(Intent.CAPTURE, "提出拍摄请求，拍摄前仍需检查设备和人物状态");
        return clarify("请明确构图、数字裁剪、机位微调、动作指导或拍照要求。");
    }
    public static Command validate(Command c, String original) {
        if (c == null || c.type() == null || c.message() == null || c.message().isBlank() || c.message().length() > 300) throw AiException.badOutput();
        Command guarded = guard(original);
        if (guarded != null) return guarded;
        return switch (c.type()) {
            case MOVE -> {
                if (!matches(original, "相机|镜头|机位")) yield clarify("请确认是否要移动相机；数字裁剪不需要机位动作。");
                if (c.direction() == null || c.step() == null || c.step() != 1) throw AiException.badOutput();
                yield new Command(Intent.MOVE, c.direction(), 1, null, null, null, c.message());
            }
            case ZOOM -> {
                if (c.zoomDelta() == null || !Double.isFinite(c.zoomDelta()) || c.zoomDelta() == 0 || Math.abs(c.zoomDelta()) > .25) throw AiException.badOutput();
                yield new Command(Intent.ZOOM, null, null, null, null, c.zoomDelta(), c.message());
            }
            case COMPOSE -> {
                if (c.composition() == null && c.framing() == null) throw AiException.badOutput();
                yield new Command(Intent.COMPOSE, null, null, c.composition(), c.framing(), null, c.message());
            }
            case CAPTURE -> matches(original, "拍|快门|照相") ? simple(Intent.CAPTURE, c.message()) : clarify("是否现在拍照？请明确确认。");
            case HOME -> matches(original, "初始|原位|复位|回零") ? simple(Intent.HOME, c.message()) : clarify("是否需要回初始位？请明确确认。");
            case STOP, GUIDE, CLARIFY -> simple(c.type(), c.message());
        };
    }
}
