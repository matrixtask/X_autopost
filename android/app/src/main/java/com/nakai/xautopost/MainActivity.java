package com.nakai.xautopost;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout list;
    private EditText apiUrl;
    private EditText token;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 32, 32, 32);

        apiUrl = new EditText(this);
        apiUrl.setHint("API URL 例: http://192.168.1.10:8787");
        root.addView(apiUrl);

        token = new EditText(this);
        token.setHint("Admin Token");
        root.addView(token);

        Button load = new Button(this);
        load.setText("読み込み");
        load.setOnClickListener(v -> loadDrafts());
        root.addView(load);

        status = new TextView(this);
        root.addView(status);

        ScrollView scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    private void loadDrafts() {
        status.setText("読み込み中...");
        new Thread(() -> {
            try {
                JSONObject response = request("GET", "/api/posts?status=draft", null);
                JSONArray posts = response.getJSONArray("posts");
                main.post(() -> renderPosts(posts));
            } catch (Exception error) {
                main.post(() -> status.setText("読み込み失敗: " + error.getMessage()));
            }
        }).start();
    }

    private void renderPosts(JSONArray posts) {
        list.removeAllViews();
        status.setText(posts.length() + "件のドラフト");
        for (int i = 0; i < posts.length(); i++) {
            JSONObject post = posts.optJSONObject(i);
            if (post == null) continue;
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(0, 24, 0, 24);

            EditText content = new EditText(this);
            content.setMinLines(3);
            content.setText(post.optString("content"));
            card.addView(content);

            TextView meta = new TextView(this);
            meta.setText(post.optString("scheduledAt") + " / " + post.optString("pillar"));
            card.addView(meta);

            LinearLayout actions = new LinearLayout(this);
            Button approve = new Button(this);
            approve.setText("承認");
            approve.setOnClickListener(v -> updatePost(post.optString("id"), content.getText().toString(), "approve", card));
            actions.addView(approve);

            Button reject = new Button(this);
            reject.setText("却下");
            reject.setOnClickListener(v -> updatePost(post.optString("id"), content.getText().toString(), "reject", card));
            actions.addView(reject);
            card.addView(actions);
            list.addView(card);
        }
    }

    private void updatePost(String id, String content, String action, View card) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("content", content);
                request("PATCH", "/api/posts/" + id, body);
                request("POST", "/api/posts/" + id + "/" + action, null);
                main.post(() -> {
                    list.removeView(card);
                    status.setText("更新しました: " + id);
                });
            } catch (Exception error) {
                main.post(() -> status.setText("更新失敗: " + error.getMessage()));
            }
        }).start();
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        URL url = new URL(apiUrl.getText().toString().replaceAll("/$", "") + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + token.getText().toString());
        connection.setRequestProperty("Content-Type", "application/json");
        if (body != null) {
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes());
            }
        }
        int code = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            code >= 400 ? connection.getErrorStream() : connection.getInputStream()
        ));
        StringBuilder result = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) result.append(line);
        if (code >= 400) throw new IllegalStateException(result.toString());
        return new JSONObject(result.toString());
    }
}
