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
@ConditionalOnProperty(name = "lensmind.device.backend", havingValue = "mujoco")
public class MujocoDeviceGateway implements DeviceGateway {
    private final RestClient simulator;

    public MujocoDeviceGateway(@Value("${lensmind.mujoco.port:8765}") int port) {
        var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
        var requests = new JdkClientHttpRequestFactory(http);
        requests.setReadTimeout(Duration.ofSeconds(3));
        // Send a content length to the local Python HTTP server.
        simulator = RestClient.builder().requestFactory(new BufferingClientHttpRequestFactory(requests))
                .baseUrl("http://127.0.0.1:" + port).build();
    }

    @Override
    public DeviceStatus status() {
        return read(simulator.get().uri("/status").retrieve());
    }

    @Override
    public DeviceStatus move(String direction, int step) {
        return post("/move", new Move(direction, step));
    }

    @Override
    public DeviceStatus home() {
        return post("/home", "{}");
    }

    @Override
    public DeviceStatus stop() {
        return post("/stop", "{}");
    }

    private DeviceStatus post(String path, Object body) {
        return read(simulator.post().uri(path).contentType(MediaType.APPLICATION_JSON).body(body).retrieve());
    }

    private DeviceStatus read(RestClient.ResponseSpec response) {
        try {
            var status = response.body(DeviceStatus.class);
            if (status == null || status.frame() == null || status.so101() == null) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "MuJoCo 未返回完整设备状态");
            }
            return status;
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().is4xxClientError()) {
                var body = error.getResponseBodyAs(SimulatorError.class);
                throw new ResponseStatusException(error.getStatusCode(),
                        body == null ? "MuJoCo 拒绝设备请求" : body.message());
            }
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "MuJoCo 渲染或控制失败", error);
        } catch (RestClientException error) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "MuJoCo 仿真服务未连接或响应超时", error);
        }
    }

    private record Move(String direction, int step) {}

    private record SimulatorError(String message) {}
}
