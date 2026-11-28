package com.example.lensmind.ai;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Writes proposals only. No device gateway or actuator is called here. */
@Component
class MotionPlanStore {
    record Plan(String schemaVersion, String planId, String createdAt, String expiresAt, String status,
                boolean executed, String sceneSha256, List<AiModelClient.MotionAction> actions) {}
    record Document(String fileName, String downloadUrl, Plan plan) {}
    private record Stored(String owner, Document document, byte[] bytes) {}
    private final Path directory;
    private final Map<String, Stored> entries = new LinkedHashMap<>();
    private final JsonMapper mapper = JsonMapper.builder().build();

    MotionPlanStore(@Value("${lensmind.ai.control-plan-dir:data/control-plans}") String directory) {
        this.directory = Path.of(directory).toAbsolutePath().normalize();
    }

    synchronized Document save(String owner, String prompt, String scene, List<AiModelClient.MotionAction> proposed) {
        String text = CommandPolicy.normalize(prompt);
        boolean requested = text.matches("(?s).*(相机|镜头|机位|机械臂).*")
                && !text.matches("(?s).*(不要|不用|不必|请勿|别|怎么|如何|为什么|能不能|[?？]|放大|缩小|数字裁剪).*");
        List<AiModelClient.MotionAction> actions = requested ? List.copyOf(proposed) : List.of();
        if (actions.size() > 1) throw AiException.badOutput();
        for (var action : actions) {
            if (!"MOVE".equals(action.type()) || action.step() != 1
                    || !Set.of("LEFT", "RIGHT", "UP", "DOWN", "FORWARD", "BACKWARD", "PITCH_UP", "PITCH_DOWN").contains(action.direction()))
                throw AiException.badOutput();
        }
        String id = UUID.randomUUID().toString();
        Instant now = Instant.now();
        try {
            String hash = scene == null ? null : HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(scene.getBytes(StandardCharsets.UTF_8)));
            Plan plan = new Plan("lensmind.motion.v1", id, now.toString(), now.plusSeconds(60).toString(), actions.isEmpty() ? "NO_ACTION" : "PROPOSED", false, hash, actions);
            String file = "lensmind-plan-" + id + ".json";
            Document document = new Document(file, "/api/ai/control-plans/" + id, plan);
            byte[] bytes = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(plan);
            Files.createDirectories(directory);
            Path temporary = Files.createTempFile(directory, ".lensmind-plan-", ".tmp");
            try {
                Files.write(temporary, bytes);
                try { Files.move(temporary, directory.resolve(file), StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temporary, directory.resolve(file)); }
            } finally { Files.deleteIfExists(temporary); }
            entries.put(id, new Stored(owner, document, bytes));
            while (entries.size() > 128) {
                String oldest = entries.keySet().iterator().next();
                Files.deleteIfExists(directory.resolve(entries.remove(oldest).document.fileName));
            }
            return document;
        } catch (Exception e) { throw new AiException(500, "无法保存机械臂计划文件，请检查计划目录写入权限。"); }
    }

    synchronized byte[] read(String owner, String id) {
        Stored entry = entries.get(id);
        if (entry == null || !entry.owner.equals(owner)) throw new AiException(404, "未找到本次会话的机械臂计划。");
        return entry.bytes.clone();
    }
}
