package com.example.lensmind.ai;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** 按官方 run-task 协议调用固定模型，无重定向、无重试；短句完成后返回浏览器。 */
@Component
class DashScopeSpeechClient {
    private final ObjectMapper mapper;
    private final LiveCallBudget budget;
    private final int timeout;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(7))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    DashScopeSpeechClient(ObjectMapper mapper, AiProperties properties, LiveCallBudget budget) {
        this.mapper = mapper; this.budget = budget;
        timeout = Math.max(1, Math.min(60, properties.timeoutSeconds()));
    }

    String transcribe(SpeechController.Connection connection, byte[] wav) {
        byte[] pcm = pcm(wav);
        return budget.call(() -> execute(connection, false, pcm, null, 1).transcript());
    }
    byte[] synthesize(SpeechController.Connection connection, String text, double rate) {
        return budget.call(() -> {
            byte[] audio = execute(connection, true, null, text, rate).audio.toByteArray();
            if (audio.length < 3 || !(audio[0] == 'I' && audio[1] == 'D' && audio[2] == '3'
                    || (audio[0] & 255) == 255 && (audio[1] & 224) == 224)) {
                throw new AiException(502, "云端 TTS 未返回有效 MP3 音频。");
            }
            return audio;
        });
    }
    static byte[] pcm(byte[] wav) {
        MediaInput.wav(wav);
        try (var stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            var format = stream.getFormat();
            if (format.getSampleRate() != 16000 || format.getChannels() != 1 || format.isBigEndian()) {
                throw AiException.badInput("云端录音需为 16kHz、16bit、小端单声道 PCM WAV。");
            }
            byte[] pcm = stream.readNBytes(480_001);
            if (pcm.length > 480_000 || pcm.length % 2 != 0) throw AiException.badInput("录音超长或 PCM 数据不完整。");
            return pcm;
        } catch (AiException e) { throw e; }
        catch (Exception e) { throw AiException.badInput("无法读取 PCM 录音。"); }
    }

    static URI endpoint(SpeechController.Connection connection) {
        if (!connection.workspace.matches("[a-zA-Z0-9][a-zA-Z0-9-]{0,79}")) throw AiException.badInput("Workspace ID 格式无效。");
        return URI.create("wss://" + connection.workspace + ".cn-beijing.maas.aliyuncs.com/api-ws/v1/inference");
    }
    static Map<String, Object> event(String action, String id, Map<String, Object> payload) {
        return Map.of("header", Map.of("action", action, "task_id", id, "streaming", "duplex"), "payload", payload);
    }
    static Map<String, Object> start(String id, boolean tts, double rate) {
        Map<String, Object> parameters = tts
                ? Map.of("text_type", "PlainText", "voice", SpeechController.VOICE, "format", "mp3", "sample_rate", 24000,
                    "volume", 50, "rate", rate, "pitch", 1, "enable_ssml", false)
                : Map.of("format", "pcm", "sample_rate", 16000, "language_hints", List.of("zh"));
        return event("run-task", id, Map.of("task_group", "audio", "task", tts ? "tts" : "asr",
                "function", tts ? "SpeechSynthesizer" : "recognition", "model", tts ? SpeechController.TTS : SpeechController.ASR,
                "parameters", parameters, "input", Map.of()));
    }
    private Task execute(SpeechController.Connection connection, boolean tts, byte[] pcm, String text, double rate) {
        String id = UUID.randomUUID().toString();
        Task task = new Task(mapper, id);
        WebSocket socket = null;
        CompletableFuture<WebSocket> opening = null;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeout);
        try {
            opening = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(7))
                    .header("Authorization", "Bearer " + connection.key()).buildAsync(endpoint(connection), task);
            socket = await(opening, deadline);
            await(socket.sendText(mapper.writeValueAsString(start(id, tts, rate)), true), deadline);
            await(task.started, deadline);
            if (tts) {
                await(socket.sendText(mapper.writeValueAsString(event("continue-task", id, Map.of("input", Map.of("text", text)))), true), deadline);
            } else {
                for (int offset = 0; offset < pcm.length; offset += 6400) {
                    await(socket.sendBinary(ByteBuffer.wrap(pcm, offset, Math.min(6400, pcm.length - offset)), true), deadline);
                }
            }
            await(socket.sendText(mapper.writeValueAsString(event("finish-task", id, Map.of("input", Map.of()))), true), deadline);
            await(task.finished, deadline);
            return task;
        } catch (TimeoutException e) { throw new AiException(504, "云端语音响应超时，未自动重试。"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AiException(503, "语音请求已中断。"); }
        catch (ExecutionException e) {
            if (e.getCause() instanceof AiException error) throw error;
            throw new AiException(502, "无法连接百炼语音服务，请核对北京地域 Key、Workspace ID 和模型权限。");
        } catch (AiException e) { throw e; }
        catch (Exception e) { throw new AiException(502, "云端语音响应无效，请检查模型及服务状态。"); }
        finally {
            if (socket != null) socket.abort();
            else if (opening != null) { opening.thenAccept(WebSocket::abort); opening.cancel(true); }
        }
    }
    private static <T> T await(CompletableFuture<T> future, long deadline) throws InterruptedException, ExecutionException, TimeoutException {
        return future.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
    }

    static final class Task implements WebSocket.Listener {
        final CompletableFuture<Void> started = new CompletableFuture<>(), finished = new CompletableFuture<>();
        final ByteArrayOutputStream audio = new ByteArrayOutputStream();
        private final ObjectMapper mapper;
        private final String id;
        private final StringBuilder fragments = new StringBuilder();
        private final SortedMap<Integer, String> sentences = new TreeMap<>();
        Task(ObjectMapper mapper, String id) { this.mapper = mapper; this.id = id; }
        String transcript() {
            String value = String.join("", sentences.values()).strip();
            if (value.isEmpty()) throw new AiException(422, "未识别到有效语音，请靠近麦克风重试。");
            return value;
        }
        private void fail(AiException error) { started.completeExceptionally(error); finished.completeExceptionally(error); }
        @Override public void onOpen(WebSocket socket) { socket.request(1); }
        @Override public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
            try {
                if (fragments.length() + data.length() > 64_000) throw new AiException(502, "语音响应消息过大。");
                fragments.append(data);
                if (last) {
                    JsonNode message = mapper.readTree(fragments.toString()); fragments.setLength(0);
                    var header = message.path("header");
                    if (!id.equals(header.path("task_id").asText())) throw new AiException(502, "语音任务标识不匹配。");
                    switch (header.path("event").asText()) {
                        case "task-started" -> started.complete(null);
                        case "task-finished" -> finished.complete(null);
                        case "task-failed" -> fail(new AiException(502, "百炼语音任务失败，请核对密钥、模型权限、额度和输入格式。"));
                        case "result-generated" -> {
                            var sentence = message.path("payload").path("output").path("sentence");
                            if (sentence.path("sentence_end").asBoolean() && !sentence.path("heartbeat").asBoolean()) {
                                int sequence = sentence.path("sentence_id").asInt(sentence.path("begin_time").asInt());
                                sentences.put(sequence, sentence.path("text").asText());
                                if (sentences.size() > 100 || sentences.values().stream().mapToInt(String::length).sum() > 600) {
                                    throw new AiException(502, "识别文字过长，请缩短指令。");
                                }
                            }
                        }
                        default -> { }
                    }
                }
            } catch (AiException e) { fail(e); }
            catch (Exception e) { fail(new AiException(502, "语音服务返回格式无效。")); }
            socket.request(1); return null;
        }
        @Override public CompletionStage<?> onBinary(WebSocket socket, ByteBuffer data, boolean last) {
            if (audio.size() + data.remaining() > 8_000_000) fail(new AiException(502, "合成音频超过大小限制。"));
            else { byte[] bytes = new byte[data.remaining()]; data.get(bytes); audio.writeBytes(bytes); }
            socket.request(1); return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket socket, int status, String reason) {
            if (!finished.isDone()) fail(new AiException(502, "语音连接提前关闭，未返回完整结果。"));
            return null;
        }
        @Override public void onError(WebSocket socket, Throwable error) { fail(new AiException(502, "语音网络连接中断，未自动重试。")); }
    }
}
