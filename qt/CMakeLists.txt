cmake_minimum_required(VERSION 3.20)
project(RisuAI LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 6.5 REQUIRED COMPONENTS
    Core
    Gui
    Quick
    QuickControls2
    Qml
    Network
    Sql
    Svg
    Multimedia
    Widgets
    Test
    WebEngineQuick
    WebEngineCore
)

find_package(ZLIB REQUIRED)

set(CORE_SOURCES
    src/core/AppConfig.hpp
    src/core/AppConfig.cpp
    src/core/DatabaseManager.hpp
    src/core/DatabaseManager.cpp
    src/core/Types.hpp
    src/core/I18n.hpp
    src/core/I18n.cpp
    src/core/SystemTrayManager.hpp
    src/core/SystemTrayManager.cpp
    src/core/SoundEffectManager.hpp
    src/core/SoundEffectManager.cpp

    src/engine/Tokenizer.hpp
    src/engine/Tokenizer.cpp
    src/engine/RegexEngine.hpp
    src/engine/RegexEngine.cpp
    src/engine/ModuleEngine.hpp
    src/engine/ModuleEngine.cpp
    src/engine/PromptEngine.hpp
    src/engine/PromptEngine.cpp
    src/engine/MemoryManager.hpp
    src/engine/MemoryManager.cpp
    src/engine/TriggerEngine.hpp
    src/engine/TriggerEngine.cpp
    src/engine/ScriptingEngine.hpp
    src/engine/ScriptingEngine.cpp
    src/engine/EmbeddingEngine.hpp
    src/engine/EmbeddingEngine.cpp
    src/engine/PluginEngine.hpp
    src/engine/PluginEngine.cpp
    src/engine/Translator.hpp
    src/engine/Translator.cpp
    src/engine/GraphMemory.hpp
    src/engine/GraphMemory.cpp

    src/storage/CharacterCardIO.hpp
    src/storage/CharacterCardIO.cpp
    src/storage/ExportImport.hpp
    src/storage/ExportImport.cpp
    src/storage/BackupLoader.hpp
    src/storage/BackupLoader.cpp
    src/storage/CloudSyncManager.hpp
    src/storage/CloudSyncManager.cpp
    src/storage/ArchivePacker.hpp
    src/storage/ArchivePacker.cpp
    src/storage/ColdStorageManager.hpp
    src/storage/ColdStorageManager.cpp

    src/network/AIProvider.hpp
    src/network/AIProvider.cpp
    src/network/OpenAIProvider.hpp
    src/network/OpenAIProvider.cpp
    src/network/ClaudeProvider.hpp
    src/network/ClaudeProvider.cpp
    src/network/GeminiProvider.hpp
    src/network/GeminiProvider.cpp
    src/network/OpenRouterProvider.hpp
    src/network/OllamaProvider.hpp
    src/network/OllamaProvider.cpp
    src/network/CustomProvider.hpp
    src/network/TTSManager.hpp
    src/network/TTSManager.cpp
    src/network/ImageGenManager.hpp
    src/network/ImageGenManager.cpp
    src/network/APIServer.hpp
    src/network/APIServer.cpp
    src/network/SyncEngine.hpp
    src/network/SyncEngine.cpp

    src/models/CharacterListModel.hpp
    src/models/CharacterListModel.cpp
    src/models/ChatMessageModel.hpp
    src/models/ChatMessageModel.cpp
    src/models/PresetListModel.hpp
    src/models/PresetListModel.cpp
    src/models/LorebookListModel.hpp
    src/models/LorebookListModel.cpp
    src/models/GroupListModel.hpp
    src/models/GroupListModel.cpp

    src/controllers/AppController.hpp
    src/controllers/AppController.cpp
    src/controllers/ChatController.hpp
    src/controllers/ChatController.cpp
    src/controllers/CharacterController.hpp
    src/controllers/CharacterController.cpp
    src/controllers/PresetController.hpp
    src/controllers/PresetController.cpp
    src/controllers/LorebookController.hpp
    src/controllers/LorebookController.cpp
    src/controllers/PersonaController.hpp
    src/controllers/PersonaController.cpp
    src/controllers/TTSController.hpp
    src/controllers/TTSController.cpp
    src/controllers/ImageGenController.hpp
    src/controllers/ImageGenController.cpp
    src/controllers/GroupChatController.hpp
    src/controllers/GroupChatController.cpp
    src/controllers/APIServerController.hpp
    src/controllers/APIServerController.cpp
)

# Main Executable
add_executable(risuai
    src/main.cpp
    ${CORE_SOURCES}
    resources.qrc
)

target_include_directories(risuai PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core
    ${CMAKE_CURRENT_SOURCE_DIR}/src/engine
    ${CMAKE_CURRENT_SOURCE_DIR}/src/storage
    ${CMAKE_CURRENT_SOURCE_DIR}/src/network
    ${CMAKE_CURRENT_SOURCE_DIR}/src/models
    ${CMAKE_CURRENT_SOURCE_DIR}/src/controllers
)

target_link_libraries(risuai PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::Qml
    Qt6::Network
    Qt6::Sql
    Qt6::Svg
    Qt6::Multimedia
    Qt6::Widgets
    Qt6::WebEngineQuick
    Qt6::WebEngineCore
    ZLIB::ZLIB
)

# Test Executable
enable_testing()

add_executable(risuai_tests
    tests/test_main.cpp
    ${CORE_SOURCES}
)

target_include_directories(risuai_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core
    ${CMAKE_CURRENT_SOURCE_DIR}/src/engine
    ${CMAKE_CURRENT_SOURCE_DIR}/src/storage
    ${CMAKE_CURRENT_SOURCE_DIR}/src/network
    ${CMAKE_CURRENT_SOURCE_DIR}/src/models
    ${CMAKE_CURRENT_SOURCE_DIR}/src/controllers
)

target_link_libraries(risuai_tests PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::Qml
    Qt6::Network
    Qt6::Sql
    Qt6::Svg
    Qt6::Multimedia
    Qt6::Widgets
    Qt6::Test
    Qt6::WebEngineQuick
    Qt6::WebEngineCore
    ZLIB::ZLIB
)

add_test(NAME RisuAITests COMMAND risuai_tests)

install(TARGETS risuai
    BUNDLE DESTINATION .
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)
