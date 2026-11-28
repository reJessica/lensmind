package com.example.lensmind.ai;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@RestController("photographyAiController")
@RequestMapping(value = "/api/ai", produces = MediaType.APPLICATION_JSON_VALUE)
class AiController {
    private static final int MAX_IMAGE_LENGTH = 1_200_000;
    private static final String SESSION_ATTRIBUTE = AiController.class.getName() + ".connection";
    private static final Set<String> LOCAL_HOSTS = Set.of("127.0.0.1", "localhost", "::1", "[::1]");
    private final AiModelClient client;
    private final ObjectMapper mapper;
    private final MotionPlanStore plans;

    private record Connected(String id, AiModelClient.Connection model) {}

    AiController(AiModelClient client, ObjectMapper mapper) {
        this(client, mapper, null);
    }

    @Autowired
    AiController(AiModelClient client, ObjectMapper mapper, MotionPlanStore plans) {
        this.client = client; this.mapper = mapper; this.plans = plans;
    }

    @GetMapping("/session")
    ResponseEntity<?> status(HttpServletRequest request) {
        requireLocal(request);
        return success(describe(connected(request)));
    }

    @PostMapping("/session")
    ResponseEntity<?> connect(HttpServletRequest request) {
        requireLocal(request);
        JsonNode details = body(request, 12_000);
        var model = client.connection(field(details, "baseUrl"), field(details, "model"), field(details, "apiKey"));
        HttpSession session = request.getSession();
        session.setMaxInactiveInterval(30 * 60);
        client.check(model);
        var connection = new Connected(UUID.randomUUID().toString(), model);
        try {
            synchronized (session) {
                session.setAttribute(SESSION_ATTRIBUTE, connection);
            }
        } catch (IllegalStateException e) {
            throw new AiException(409, "连接测试期间会话已关闭，请重新连接。");
        }
        return success(describe(connection));
    }

    @DeleteMapping("/session")
    ResponseEntity<?> disconnect(HttpServletRequest request) {
        requireLocal(request);
        HttpSession session = request.getSession(false);
        if (session != null) session.removeAttribute(SESSION_ATTRIBUTE);
        return success(describe(null));
    }

    @PostMapping("/analyze")
    ResponseEntity<?> analyze(HttpServletRequest request) {
        requireLocal(request);
        Connected connection = connected(request);
        if (connection == null) throw new AiException(409, "尚未连接模型或连接已过期，请重新连接。");
        JsonNode input = body(request, MAX_IMAGE_LENGTH * 2 + 10_000);
        if (!connection.id().equals(field(input, "connectionId"))) {
            throw new AiException(409, "接收图片的模型连接已变更，请确认后再试。");
        }
        String prompt = field(input, "prompt").strip();
        if (prompt.length() > 500) throw new AiException(400, "拍摄要求最多 500 字。");
        if ("reference-plan".equals(field(input, "mode"))) {
            if (input.path("reference").isMissingNode()) throw new AiException(400, "请先选择参考图。");
            String reference = validateImage(field(input, "reference"));
            if (connected(request) != connection) throw new AiException(409, "模型连接已过期或变更，请确认后再试。");
            var plan = client.planReference(connection.model(), prompt, reference);
            if (connected(request) != connection) throw new AiException(409, "模型会话已变化，丢弃本次结果。");
            return success(Map.of("referencePlan", plan));
        }
        boolean assistant = "assistant".equals(field(input, "mode"));
        if (assistant && prompt.isBlank()) throw new AiException(400, "请填写要交给摄影助手的问题。");
        String scene = assistant && input.path("scene").isMissingNode() ? null : validateImage(field(input, "scene"));
        String reference = input.path("reference").isMissingNode() ? null : validateImage(field(input, "reference"));
        if (scene == null && reference != null) throw new AiException(400, "对照参考图需要当前取景。");
        if (connected(request) != connection) throw new AiException(409, "模型连接已过期或变更，请确认后再试。");
        var result = assistant ? client.assist(connection.model(), prompt, scene, reference)
                : client.analyze(connection.model(), prompt, scene, reference);
        if (connected(request) != connection) throw new AiException(409, "模型会话已变化，丢弃本次结果。");
        if (plans == null) return success(result);
        var document = plans.save(request.getSession().getId(), prompt, scene, result.actions());
        var reply = new java.util.LinkedHashMap<String, Object>();
        reply.put("summary", result.summary()); reply.put("feedback", result.feedback());
        reply.put("observations", result.observations()); reply.put("targets", result.targets());
        reply.put("steps", result.steps()); reply.put("settings", result.settings());
        reply.put("controlPlan", document);
        return success(reply);
    }

    @GetMapping("/control-plans/{id}") ResponseEntity<byte[]> downloadPlan(@PathVariable String id, HttpServletRequest request) {
        requireLocal(request);
        if (plans == null || request.getSession(false) == null || !id.matches("[a-f0-9-]{36}"))
            throw new AiException(404, "未找到本次会话的机械臂计划。");
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_JSON)
                .header("Content-Disposition", "attachment; filename=\"lensmind-plan-" + id + ".json\"")
                .body(plans.read(request.getSession().getId(), id));
    }

    @ExceptionHandler(AiException.class)
    ResponseEntity<?> handle(AiException exception) {
        return ResponseEntity.status(exception.status()).cacheControl(CacheControl.noStore()).body(Map.of("message", exception.getMessage()));
    }

    private ResponseEntity<?> success(Object result) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(result);
    }

    private Map<String, Object> describe(Connected connection) {
        if (connection == null) return Map.of("connected", false, "referencePlan", true);
        return Map.of("connected", true, "id", connection.id(), "model", connection.model().model,
                "host", connection.model().endpoint.getHost(), "expiresAt", connection.model().expiresAt,
                "referencePlan", true);
    }

    private Connected connected(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session == null) return null;
        try {
            synchronized (session) {
                Connected connection = (Connected) session.getAttribute(SESSION_ATTRIBUTE);
                if (connection != null && !Instant.now().isBefore(connection.model().expiresAt)) {
                    session.removeAttribute(SESSION_ATTRIBUTE);
                    return null;
                }
                return connection;
            }
        } catch (IllegalStateException ignored) {
            return null;
        }
    }

    static void requireLocal(HttpServletRequest request) {
        String host = request.getServerName();
        String origin = request.getHeader("Origin");
        String fetchSite = request.getHeader("Sec-Fetch-Site");
        try {
            if (LOCAL_HOSTS.contains(host) && InetAddress.getByName(request.getRemoteAddr()).isLoopbackAddress()
                    && (fetchSite == null || "same-origin".equals(fetchSite) || "none".equals(fetchSite))
                    && (origin == null || sameOrigin(request, URI.create(origin)))) return;
        } catch (IOException | IllegalArgumentException ignored) {
            // 无法验证来源时拒绝请求。
        }
        throw new AiException(403, "模型接入仅限本机打开的灵眸工作台。");
    }

    private static boolean sameOrigin(HttpServletRequest request, URI origin) {
        int port = origin.getPort() == -1 ? ("https".equals(origin.getScheme()) ? 443 : 80) : origin.getPort();
        return request.getScheme().equals(origin.getScheme()) && request.getServerName().equals(origin.getHost())
                && request.getServerPort() == port && origin.getRawUserInfo() == null;
    }

    private JsonNode body(HttpServletRequest request, int limit) {
        try {
            String contentType = request.getContentType();
            if (contentType == null || !MediaType.APPLICATION_JSON.includes(MediaType.parseMediaType(contentType))) {
                throw new AiException(415, "请发送 JSON 请求。");
            }
            byte[] data = request.getInputStream().readNBytes(limit + 1);
            if (data.length > limit) throw new AiException(413, "图片或请求过大，请缩小后重试。");
            JsonNode result = mapper.readTree(data);
            if (result != null && result.isObject()) return result;
        } catch (IOException | IllegalArgumentException | tools.jackson.core.JacksonException ignored) {
            // 不回传解析错误中的原始内容。
        }
        throw new AiException(400, "模型请求格式无效。");
    }

    private String field(JsonNode input, String name) {
        JsonNode value = input.path(name);
        return value.isTextual() ? value.asText() : "";
    }

    private String validateImage(String input) {
        if (input.length() > MAX_IMAGE_LENGTH) throw new AiException(413, "图片过大，请缩小后重试。");
        if (input.startsWith(AiModelClient.JPEG)) {
            try {
                byte[] data = Base64.getDecoder().decode(input.substring(AiModelClient.JPEG.length()));
                if (data.length > 4 && data[0] == (byte) 0xff && data[1] == (byte) 0xd8
                        && data[data.length - 2] == (byte) 0xff && data[data.length - 1] == (byte) 0xd9) return input;
            } catch (IllegalArgumentException ignored) {
                // 图片编码格式无效。
            }
        }
        throw new AiException(400, "图片格式无效，请使用工作台重新生成取景或参考图。");
    }
}
