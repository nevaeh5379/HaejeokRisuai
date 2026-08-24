@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package io.github.nevaeh5379.androidhaejeokrisuai.ui

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfig
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageMode
import kotlinx.coroutines.launch

@Composable
internal fun NativeRisuApp(context: Context) {
    val controller = remember { NativeRisuController(context) }
    LaunchedEffect(Unit) { controller.initialize() }

    Surface(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxSize()) {
            when (controller.screen) {
                NativeScreen.SETUP -> SetupScreen(controller)
                NativeScreen.CHARACTERS -> CharacterScreen(controller)
                NativeScreen.MODEL_SETTINGS -> ModelSettingsScreen(controller)
                NativeScreen.CHATS -> ChatListScreen(controller)
                NativeScreen.CHAT -> MessageScreen(controller)
            }
            if (controller.loading) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.18f)) {
                    Box(contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
            }
            controller.error?.let { message ->
                ErrorBanner(message = message, onDismiss = controller::dismissError)
            }
        }
    }
}

@Composable
private fun SetupScreen(controller: NativeRisuController) {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(StorageMode.LOCAL_SQLITE) }
    var baseUrl by remember { mutableStateOf("http://192.168.0.2:6001") }
    var authToken by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("HaejeokRisuAI Native", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("WebView가 아닌 네이티브 Android 포트", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(24.dp))
        StorageModeRow(
            selected = mode == StorageMode.LOCAL_SQLITE,
            title = "내장 SQLite",
            subtitle = "Risu relational-schema-v3를 기기 내부에 저장",
            onClick = { mode = StorageMode.LOCAL_SQLITE },
        )
        StorageModeRow(
            selected = mode == StorageMode.REMOTE_SERVER,
            title = "외부 SQL 서버",
            subtitle = "Risu Node API를 통해 PostgreSQL 등 서버 저장소 사용",
            onClick = { mode = StorageMode.REMOTE_SERVER },
        )
        if (mode == StorageMode.REMOTE_SERVER) {
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Risu 서버 URL") },
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = authToken,
                onValueChange = { authToken = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("risu-auth 토큰 / 비밀번호") },
                singleLine = true,
            )
        }
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = {
                scope.launch {
                    controller.configure(
                        StorageConfig(mode = mode, baseUrl = baseUrl.trim(), authToken = authToken),
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("시작") }
    }
}

@Composable
private fun StorageModeRow(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(Modifier.padding(start = 8.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun CharacterScreen(controller: NativeRisuController) {
    val scope = rememberCoroutineScope()
    val overview = controller.overview
    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { controller.importCharacterCard(uri) }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("캐릭터") },
                actions = {
                    TextButton(onClick = controller::openGenerationSettings) { Text("모델") }
                    TextButton(onClick = { importLauncher.launch(arrayOf("image/png", "application/json")) }) { Text("가져오기") }
                    TextButton(onClick = { scope.launch { controller.refreshCharacters() } }) { Text("새로고침") }
                    TextButton(onClick = controller::resetStorageSelection) { Text("저장소") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(
                "${controller.config?.mode?.name ?: "-"} · revision ${overview?.revision ?: 0}",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.labelMedium,
            )
            if (overview?.characters.isNullOrEmpty()) {
                EmptyState("아직 캐릭터가 없답니다. 위의 가져오기에서 PNG 또는 JSON 캐릭터 카드를 고르시와요.")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(overview!!.characters, key = CharacterSummary::id) { character ->
                        CharacterRow(character) { scope.launch { controller.openCharacter(character) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelSettingsScreen(controller: NativeRisuController) {
    val scope = rememberCoroutineScope()
    val current = controller.overview?.generationSettings ?: GenerationSettings()
    var aiModel by remember(current) { mutableStateOf(current.aiModel.ifBlank { "gemini-3-flash-preview" }) }
    var username by remember(current) { mutableStateOf(current.username.ifBlank { "User" }) }
    var maxResponse by remember(current) { mutableStateOf(current.maxResponse.toString()) }
    var temperature by remember(current) { mutableStateOf(current.temperature.toString()) }
    var topP by remember(current) { mutableStateOf(current.topP?.toString().orEmpty()) }
    var googleKey by remember(current) { mutableStateOf(current.googleApiKey) }
    var claudeKey by remember(current) { mutableStateOf(current.claudeAPIKey) }
    var openAiKey by remember(current) { mutableStateOf(current.openAIKey) }
    var openRouterKey by remember(current) { mutableStateOf(current.openrouterKey) }
    var openRouterModel by remember(current) { mutableStateOf(current.openrouterRequestModel) }
    var proxyUrl by remember(current) { mutableStateOf(current.forceReplaceUrl) }
    var proxyKey by remember(current) { mutableStateOf(current.proxyKey) }
    var proxyModel by remember(current) {
        mutableStateOf(if (current.proxyRequestModel == "custom") current.customProxyRequestModel else current.proxyRequestModel)
    }
    var autofillProxyUrl by remember(current) { mutableStateOf(current.autofillRequestUrl) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("모델 설정") },
                navigationIcon = { TextButton(onClick = controller::back) { Text("←") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "네이티브 생성 지원: Gemini · Claude · GPT/OpenAI · OpenRouter · OpenAI-compatible reverse proxy",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedTextField(
                value = aiModel,
                onValueChange = { aiModel = it },
                label = { Text("Risu aiModel / 모델 ID") },
                supportingText = { Text("예: gemini-3-flash-preview, claude-sonnet-4-6, gpt-4o, openrouter, reverse_proxy") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("사용자 이름") },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = maxResponse,
                    onValueChange = { maxResponse = it.filter(Char::isDigit) },
                    label = { Text("최대 응답 토큰") },
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = temperature,
                    onValueChange = { temperature = it },
                    label = { Text("Temperature") },
                    modifier = Modifier.weight(1f),
                )
            }
            OutlinedTextField(
                value = topP,
                onValueChange = { topP = it },
                label = { Text("Top P (선택)") },
                modifier = Modifier.fillMaxWidth(),
            )

            when {
                aiModel.startsWith("gemini", ignoreCase = true) -> {
                    SecretField(googleKey, { googleKey = it }, "Gemini API Key")
                }
                aiModel.startsWith("claude", ignoreCase = true) -> {
                    SecretField(claudeKey, { claudeKey = it }, "Anthropic API Key")
                }
                aiModel.equals("openrouter", ignoreCase = true) -> {
                    OutlinedTextField(
                        value = openRouterModel,
                        onValueChange = { openRouterModel = it },
                        label = { Text("OpenRouter 모델") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    SecretField(openRouterKey, { openRouterKey = it }, "OpenRouter API Key")
                }
                aiModel.equals("reverse_proxy", ignoreCase = true) -> {
                    OutlinedTextField(
                        value = proxyUrl,
                        onValueChange = { proxyUrl = it },
                        label = { Text("Reverse proxy base URL") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = proxyModel,
                        onValueChange = { proxyModel = it },
                        label = { Text("Reverse proxy 모델") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    SecretField(proxyKey, { proxyKey = it }, "Reverse proxy API Key")
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("/v1/chat/completions 자동 완성", modifier = Modifier.weight(1f))
                        Switch(checked = autofillProxyUrl, onCheckedChange = { autofillProxyUrl = it })
                    }
                }
                else -> SecretField(openAiKey, { openAiKey = it }, "OpenAI API Key")
            }

            Button(
                onClick = {
                    val next = current.copy(
                        aiModel = aiModel.trim(),
                        username = username.ifBlank { "User" },
                        maxResponse = maxResponse.toIntOrNull()?.coerceIn(1, 131072) ?: current.maxResponse,
                        temperature = temperature.toDoubleOrNull()?.coerceIn(0.0, 2.0) ?: current.temperature,
                        topP = topP.toDoubleOrNull()?.coerceIn(0.0, 1.0),
                        googleApiKey = googleKey.trim(),
                        claudeAPIKey = claudeKey.trim(),
                        openAIKey = openAiKey.trim(),
                        openrouterKey = openRouterKey.trim(),
                        openrouterRequestModel = openRouterModel.trim(),
                        forceReplaceUrl = proxyUrl.trim(),
                        proxyKey = proxyKey.trim(),
                        proxyRequestModel = proxyModel.trim(),
                        customProxyRequestModel = "",
                        autofillRequestUrl = autofillProxyUrl,
                    )
                    scope.launch { controller.saveGenerationSettings(next) }
                },
                enabled = aiModel.isNotBlank() && !controller.loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("SQL에 저장") }
        }
    }
}

@Composable
private fun SecretField(value: String, onValueChange: (String) -> Unit, label: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun CharacterRow(character: CharacterSummary, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 14.dp)) {
        Text(character.name.ifBlank { "이름 없는 캐릭터" }, fontWeight = FontWeight.SemiBold)
        Text(character.kind, style = MaterialTheme.typography.bodySmall)
    }
    HorizontalDivider()
}

@Composable
private fun ChatListScreen(controller: NativeRisuController) {
    val scope = rememberCoroutineScope()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(controller.selectedCharacter?.name ?: "채팅") },
                navigationIcon = { TextButton(onClick = controller::back) { Text("←") } },
            )
        },
        bottomBar = {
            Button(
                onClick = { scope.launch { controller.createNewChat() } },
                enabled = !controller.loading,
                modifier = Modifier.fillMaxWidth().padding(12.dp),
            ) { Text("새 채팅") }
        },
    ) { padding ->
        if (controller.chats.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding)) { EmptyState("이 캐릭터에는 채팅이 없사와요.") }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(controller.chats, key = ChatSummary::id) { chat ->
                    Column(Modifier.fillMaxWidth().clickable { scope.launch { controller.openChat(chat) } }.padding(18.dp)) {
                        Text(chat.name.ifBlank { "채팅" }, fontWeight = FontWeight.SemiBold)
                        if (chat.note.isNotBlank()) Text(chat.note, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun MessageScreen(controller: NativeRisuController) {
    val scope = rememberCoroutineScope()
    var input by remember(controller.selectedChat?.id) { mutableStateOf("") }
    val page = controller.messagePage
    val listState = rememberLazyListState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(controller.selectedChat?.name?.ifBlank { "채팅" } ?: "채팅") },
                navigationIcon = { TextButton(onClick = controller::back) { Text("←") } },
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("메시지") },
                    maxLines = 5,
                )
                Button(
                    onClick = {
                        val text = input
                        input = ""
                        scope.launch { controller.sendUserMessage(text) }
                    },
                    modifier = Modifier.padding(start = 8.dp),
                    enabled = input.isNotBlank() && !controller.loading,
                ) { Text(if (controller.loading) "생성 중" else "전송") }
            }
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (page?.hasMore == true) {
                item {
                    OutlinedButton(
                        onClick = { scope.launch { controller.loadOlderMessages() } },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("이전 메시지 불러오기") }
                }
            }
            items(page?.messages.orEmpty(), key = MessageRecord::id) { message -> MessageBubble(message) }
            item { Spacer(Modifier.height(4.dp)) }
        }
    }
}

@Composable
private fun MessageBubble(message: MessageRecord) {
    val isUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(modifier = Modifier.fillMaxWidth(0.86f)) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    if (isUser) "You" else message.name ?: "Character",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
                Text(message.data)
            }
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ErrorBanner(message: String, onDismiss: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        tonalElevation = 8.dp,
        shadowElevation = 8.dp,
        color = MaterialTheme.colorScheme.errorContainer,
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
            TextButton(onClick = onDismiss) { Text("닫기") }
        }
    }
}
