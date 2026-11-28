package com.example.lensmind.ai;

import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Owns only the local speech process it launches; never starts device services. */
@Component
class LocalAsrProcess implements DisposableBean {
    private final boolean enabled;
    private final int port;
    private final String python;
    private final Path root;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(400)).build();
    private volatile Process process;
    private volatile boolean closing;
    private volatile boolean attempted;
    private volatile String message = "本地 ASR 正在自动准备，请稍候。";

    LocalAsrProcess(@Value("${lensmind.local-asr.auto-start:true}") boolean enabled,
                    @Value("${lensmind.local-asr.port:9001}") int port,
                    @Value("${lensmind.local-asr.python:}") String python,
                    @Value("${lensmind.local-asr.project-dir:.}") String project) {
        this.enabled = enabled; this.port = port; this.python = python;
        this.root = Path.of(project).toAbsolutePath().normalize();
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid local ASR port");
    }

    @EventListener(ApplicationReadyEvent.class)
    public synchronized void start() {
        if (attempted || closing) return;
        attempted = true;
        if (!enabled) { message = "本地 ASR 自动启动已关闭，请手动启动识别服务。"; return; }
        Thread worker = new Thread(this::prepare, "lensmind-asr-start");
        worker.setDaemon(true); worker.start();
    }

    protected boolean healthy() {
        try {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health"))
                    .timeout(Duration.ofMillis(600)).GET().build();
            var response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (var input = response.body()) {
                var result = JsonMapper.builder().build().readTree(input.readNBytes(4096));
                return response.statusCode() == 200 && result.path("ready").asBoolean(false)
                        && "LOCAL".equals(result.path("mode").asString(""))
                        && "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30".equals(result.path("model").asString(""));
            }
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        catch (Exception e) { return false; }
    }

    protected boolean portAvailable() {
        try (var socket = new ServerSocket()) {
            socket.bind(new InetSocketAddress("127.0.0.1", port)); return true;
        } catch (IOException e) { return false; }
    }

    List<String> command() {
        List<String> command = new ArrayList<>();
        if (!python.isBlank()) command.add(python);
        else {
            boolean windows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows");
            Path venv = root.resolve(windows ? ".venv-asr/Scripts/python.exe" : ".venv-asr/bin/python");
            if (Files.isRegularFile(venv)) command.add(venv.toString());
            else command.add(windows ? "python" : "python3");
        }
        command.addAll(List.of("-u", root.resolve("scripts/start_local_asr.py").toString(), "--port", String.valueOf(port)));
        return command;
    }

    protected Process launch() throws IOException {
        List<String> command = command();
        try { return new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true).start(); }
        catch (IOException e) {
            if (!python.isBlank() || !command.get(0).equals("python")) throw e;
            command.set(0, "py"); command.add(1, "-3.12");
            return new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true).start();
        }
    }

    private void prepare() {
        try {
            if (healthy()) { message = "已复用现有本地 ASR。"; return; }
            if (!portAvailable()) { message = "本地 ASR 端口 " + port + " 被其他服务占用，请检查端口配置。"; return; }
            if (!Files.isRegularFile(root.resolve("scripts/start_local_asr.py"))) {
                message = "未找到 ASR 启动脚本，请从项目根目录启动或设置 LENSMIND_ASR_PROJECT_DIR。"; return;
            }
            synchronized (this) {
                if (closing) return;
                process = launch();
            }
            Thread output = new Thread(() -> {
                try (var reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) if (line.startsWith("LENSMIND_ASR: ")) message = line.substring(14);
                } catch (IOException ignored) { }
            }, "lensmind-asr-progress");
            output.setDaemon(true); output.start();
            long until = System.nanoTime() + Duration.ofMinutes(3).toNanos();
            while (!closing && System.nanoTime() < until) {
                if (healthy()) { message = "本地 ASR 已就绪。"; return; }
                if (!process.isAlive()) {
                    output.join(1000);
                    if (message.contains("正在") || message.contains("首次")) message = "本地 ASR 启动失败，请按 docs/LOCAL_ASR.md 检查环境和模型。";
                    return;
                }
                Thread.sleep(250);
            }
            if (!closing) { message = "本地 ASR 自动准备超时，请检查 Python 环境、网络和模型权重。"; stopOwned(); }
        } catch (IOException e) { message = "无法启动 Python，请安装 Python 3.12，或设置 LENSMIND_ASR_PYTHON 为解释器完整路径。"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    String failureHint() {
        if (message.equals("本地 ASR 已就绪。") || message.equals("已复用现有本地 ASR。"))
            return process != null && !process.isAlive() ? "本地 ASR 已退出，请重启后端检查环境。"
                    : "本地 ASR 未响应，请稍候再试或检查本机识别进程。";
        return message;
    }

    private void stopOwned() {
        Process owned = process;
        if (owned == null) return;
        owned.descendants().forEach(child -> child.destroyForcibly());
        owned.destroyForcibly();
    }

    @Override public synchronized void destroy() { closing = true; stopOwned(); }
}
