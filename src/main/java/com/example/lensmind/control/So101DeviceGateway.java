package com.example.lensmind.control;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.BufferingClientHttpRequestFactory;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.server.ResponseStatusException;

@Service
@ConditionalOnProperty(name = "lensmind.device.backend", havingValue = "so101")
public class So101DeviceGateway implements DeviceGateway {
    private final RestClient arm;

    public So101DeviceGateway(@Value("${lensmind.so101.bridge-port:8766}") int port,
                              @Value("${lensmind.so101.token:}") String token) {
        if (token.isBlank()) throw new IllegalArgumentException("SO-101 bridge token is required");
        var requests = new JdkClientHttpRequestFactory(HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(500)).build());
        requests.setReadTimeout(Duration.ofSeconds(3));
        arm = RestClient.builder()
                .requestFactory(new BufferingClientHttpRequestFactory(requests))
                .baseUrl("http://127.0.0.1:" + port)
                .defaultHeader("X-LensMind-Token", token).build();
    }

    @Override public DeviceStatus status() { return read(arm.get().uri("/status").retrieve()); }
    public DeviceStatus armAtNeutral() { return post("/arm", "{}"); }
    public DeviceStatus releaseTorque() { return post("/release", new Release(true)); }
    @Override public DeviceStatus move(String direction, int step) { return post("/move", new Move(direction, step)); }
    @Override public DeviceStatus stop() { return post("/stop", "{}"); }

    @Override
    public DeviceStatus home() {
        throw new ResponseStatusException(HttpStatus.CONFLICT, "实机回中立位需要现场操作");
    }

    private DeviceStatus post(String path, Object body) {
        return read(arm.post().uri(path).contentType(MediaType.APPLICATION_JSON).body(body).retrieve());
    }

    private DeviceStatus read(RestClient.ResponseSpec response) {
        try {
            DeviceStatus status = response.body(DeviceStatus.class);
            if (status == null || !"SO101".equals(status.mode())) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "没有收到真实 SO-101 状态");
            }
            return status;
        } catch (RestClientResponseException error) {
            var body = error.getResponseBodyAs(BridgeError.class);
            throw new ResponseStatusException(error.getStatusCode(), body == null ? "实机控制异常" : body.message());
        } catch (RestClientException error) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "实机控制端未连接或响应超时", error);
        }
    }

    private record Move(String direction, int step) {}
    private record Release(boolean supported) {}
    private record BridgeError(String message) {}
}
