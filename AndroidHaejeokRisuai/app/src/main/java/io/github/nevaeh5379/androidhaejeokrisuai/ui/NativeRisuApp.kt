@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package io.github.nevaeh5379.androidhaejeokrisuai.ui

import android.content.Context
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.unit.dp
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
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
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("캐릭터") },
                actions = {
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
                EmptyState("아직 캐릭터가 없답니다. 로컬 모드는 다음 단계에서 카드 가져오기/생성을 연결할 것이와요.")
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
                        scope.launch { controller.appendUserMessage(text) }
                    },
                    modifier = Modifier.padding(start = 8.dp),
                    enabled = input.isNotBlank(),
                ) { Text("추가") }
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
