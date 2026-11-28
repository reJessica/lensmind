package com.example.lensmind.ai;

import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** 按尝试调用次数限额，不等同于人民币预算；重启会清零，云端账单为准。 */
@Component
public class LiveCallBudget {
    private final AiProperties properties;
    private final AtomicInteger attempts = new AtomicInteger();
    private final Semaphore concurrency = new Semaphore(2);
    public LiveCallBudget(AiProperties properties) { this.properties = properties; }
    public int used() { return attempts.get(); }
    public int limit() { return Math.max(0, properties.maxLiveCalls()); }
    public <T> T call(Supplier<T> action) {
        if (!concurrency.tryAcquire()) {
            throw new AiException(HttpStatus.TOO_MANY_REQUESTS, "AI_BUSY", "模型调用繁忙，请等待当前请求完成");
        }
        try {
            while (true) {
                int current = attempts.get();
                if (current >= limit()) {
                    throw new AiException(HttpStatus.TOO_MANY_REQUESTS, "LIVE_CALL_LIMIT",
                            "本机调用次数已达上限（" + current + "/" + limit()
                            + "），不是供应商余额提示。可调整 LENSMIND_MAX_LIVE_CALLS 后重启后端。");
                }
                if (attempts.compareAndSet(current, current + 1)) break;
            }
            return action.get();
        } finally { concurrency.release(); }
    }
}
